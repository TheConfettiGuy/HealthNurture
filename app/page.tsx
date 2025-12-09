"use client";

import React, {
  useEffect,
  useRef,
  useState,
  KeyboardEventHandler,
} from "react";

import { auth, db } from "@/lib/firebase";
import { onAuthStateChanged, signInAnonymously } from "firebase/auth";
import { arrayUnion, doc, getDoc, setDoc } from "firebase/firestore";

/* ===== Types ===== */

type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
  createdAt: string; // ISO or "" for first render
};

type UserChatDoc = {
  gender?: string;
  neighborhood?: string;
  age?: string;
  messages?: ChatMessage[];
};

/* ===== Constants ===== */

const initialMessages: ChatMessage[] = [
  {
    role: "assistant",
    content:
      "Welcome to Health Nurture. You can ask me about puberty, sexual and reproductive health, emotions and relationships. أهلاً بك في هيلث نيرتشر، يمكنك سؤالي عن البلوغ، الصحة الجنسية، والمشاعر والعلاقات.",
    createdAt: "",
  },
];

const primaryColor = "#7387c9";
const secondaryColor = "#dfaae3";

function containsArabic(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

/* ===== Icons ===== */

const IconSend: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
    <path
      d="M4 4.5 20 12 4 19.5 6.5 12 4 4.5Z"
      className="stroke-current"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
    <path
      d="M6.5 12H12"
      className="stroke-current"
      strokeWidth="1.7"
      strokeLinecap="round"
    />
  </svg>
);

const IconSpeaker: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
    <path
      d="M5 10v4h3l4 3V7l-4 3H5Z"
      className="stroke-current"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <path
      d="M16 9a3 3 0 0 1 0 6"
      className="stroke-current"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
    <path
      d="M18.5 6.5A6 6 0 0 1 18.5 17.5"
      className="stroke-current"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);

/* ===== Component ===== */

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);

  // Typewriter
  const [typingState, setTypingState] = useState<{
    index: number;
    text: string;
    pos: number;
  } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // TTS
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);
  const [audioStatus, setAudioStatus] = useState<"loading" | "playing" | null>(
    null
  );
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Intro answers
  const [showIntro, setShowIntro] = useState(true);
  const [gender, setGender] = useState("");
  const [neighborhood, setNeighborhood] = useState("");
  const [age, setAge] = useState("");

  // Firebase user
  const [userId, setUserId] = useState<string | null>(null);
  const [userLoading, setUserLoading] = useState(true);

  // Profile & initial loader
  const [profileChecking, setProfileChecking] = useState(true);
  const [bootTimerDone, setBootTimerDone] = useState(false);

  const uiLoading = userLoading || profileChecking || !bootTimerDone;

  /* ===== Firebase: Auth ===== */

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      try {
        if (user) {
          setUserId(user.uid);
        } else {
          const cred = await signInAnonymously(auth);
          setUserId(cred.user.uid);
        }
      } catch (err) {
        console.error("Firebase auth error:", err);
      } finally {
        setUserLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  /* ===== 3-second boot timer ===== */

  useEffect(() => {
    const t = setTimeout(() => setBootTimerDone(true), 3000);
    return () => clearTimeout(t);
  }, []);

  /* ===== Firebase: load ONLY profile (once) ===== */

  useEffect(() => {
    if (!userId) return;

    const fetchProfile = async () => {
      setProfileChecking(true);
      try {
        const userRef = doc(db, "userChats", userId);
        const snap = await getDoc(userRef);

        if (snap.exists()) {
          const data = snap.data() as UserChatDoc;
          const g = data.gender || "";
          const n = data.neighborhood || "";
          const a = data.age || "";

          setGender(g);
          setNeighborhood(n);
          setAge(a);

          if (g && n && a) {
            setShowIntro(false);
          } else {
            setShowIntro(true);
          }
        } else {
          setShowIntro(true);
        }
      } catch (err) {
        console.error("Error fetching profile:", err);
        setShowIntro(true);
      } finally {
        setProfileChecking(false);
      }
    };

    fetchProfile();
  }, [userId]);

  /* ===== Effects ===== */

  // Set timestamp for the very first welcome message (client-only)
  useEffect(() => {
    setMessages((prev) => {
      if (!prev.length) return prev;
      const next = [...prev];
      if (!next[0].createdAt) {
        next[0] = { ...next[0], createdAt: new Date().toISOString() };
      }
      return next;
    });
  }, []);

  // Auto scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, typingState]);

  // Cleanup TTS
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  // Typewriter animation
  useEffect(() => {
    if (!typingState) return;

    if (typingState.pos >= typingState.text.length) {
      setTypingState(null);
      return;
    }

    const timeout = setTimeout(() => {
      setMessages((prev) => {
        const next = [...prev];
        const msg = next[typingState.index];
        if (!msg) return prev;
        msg.content = typingState.text.slice(0, typingState.pos + 1);
        return next;
      });

      setTypingState((prev) => (prev ? { ...prev, pos: prev.pos + 1 } : null));
    }, 15);

    return () => clearTimeout(timeout);
  }, [typingState]);

  /* ===== Helpers ===== */

  const formatTime = (iso: string) => {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  /* ===== TTS ===== */

  const speakMessage = async (msg: ChatMessage, index: number) => {
    try {
      if (speakingIndex === index && audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
        audioRef.current = null;
        setSpeakingIndex(null);
        setAudioStatus(null);
        return;
      }

      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
        audioRef.current = null;
      }

      setSpeakingIndex(index);
      setAudioStatus("loading");

      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: msg.content }),
      });

      if (!res.ok) {
        console.error("TTS error:", await res.text());
        setSpeakingIndex(null);
        setAudioStatus(null);
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;

      audio.onplaying = () => setAudioStatus("playing");
      audio.onended = () => {
        URL.revokeObjectURL(url);
        audioRef.current = null;
        setSpeakingIndex(null);
        setAudioStatus(null);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        audioRef.current = null;
        setSpeakingIndex(null);
        setAudioStatus(null);
      };

      try {
        await audio.play();
      } catch (err) {
        console.error("Audio play failed:", err);
        URL.revokeObjectURL(url);
        audioRef.current = null;
        setSpeakingIndex(null);
        setAudioStatus(null);
      }
    } catch (err) {
      console.error("TTS failed:", err);
      setSpeakingIndex(null);
      setAudioStatus(null);
    }
  };

  /* ===== Firestore writes ===== */

  const saveProfile = async () => {
    if (!userId) return;
    const userRef = doc(db, "userChats", userId);
    try {
      await setDoc(
        userRef,
        {
          gender,
          neighborhood,
          age,
        },
        { merge: true }
      );
    } catch (err) {
      console.error("Error saving profile:", err);
    }
  };

  const appendMessagesToFirestore = async (
    userMsg: ChatMessage,
    assistantMsg: ChatMessage
  ) => {
    if (!userId) return;
    const userRef = doc(db, "userChats", userId);

    try {
      await setDoc(
        userRef,
        {
          gender,
          neighborhood,
          age,
          messages: arrayUnion(userMsg, assistantMsg),
        },
        { merge: true }
      );
    } catch (err) {
      console.error("Error appending messages:", err);
    }
  };

  /* ===== Chat send ===== */

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isSending || showIntro || uiLoading) return;

    const now = new Date().toISOString();
    const userMessage: ChatMessage = {
      role: "user",
      content: trimmed,
      createdAt: now,
    };

    const optimisticMessages = [...messages, userMessage];

    setMessages(optimisticMessages);
    setInput("");
    setIsSending(true);

    try {
      const payload = {
        messages: optimisticMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      };

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        console.error("Chat error:", await res.text());
        throw new Error("Chat request failed");
      }

      const data = await res.json();
      const fullText: string = data.message?.content ?? "";

      const createdAt = new Date().toISOString();
      const assistantIndex = optimisticMessages.length;
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: "",
        createdAt,
      };

      const withAssistant = [...optimisticMessages, assistantMessage];

      setMessages(withAssistant);
      setTypingState({ index: assistantIndex, text: fullText, pos: 0 });

      const assistantForStore: ChatMessage = {
        ...assistantMessage,
        content: fullText,
      };
      void appendMessagesToFirestore(userMessage, assistantForStore);
    } catch (err) {
      console.error(err);
      const errorMessage: ChatMessage = {
        role: "assistant",
        content:
          "Something went wrong while trying to answer. Please try again later. حدث خطأ أثناء محاولة الإجابة، يرجى المحاولة لاحقاً.",
        createdAt: new Date().toISOString(),
      };
      const newMsgs = [...optimisticMessages, errorMessage];
      setMessages(newMsgs);
      void appendMessagesToFirestore(userMessage, errorMessage);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleStartChat = () => {
    setShowIntro(false);
    void saveProfile();
  };

  const showTypingBubble = isSending && !typingState;
  const introValid = gender && neighborhood && age;

  /* ===== Render ===== */

return (
  <>
    <style jsx global>{`
      @keyframes waveBounce {
        0%,
        100% {
          transform: scaleY(0.5);
          opacity: 0.6;
        }
        50% {
          transform: scaleY(1.4);
          opacity: 1;
        }
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `}</style>

    {/* Full-screen loader while checking auth/profile + 3s timer */}
    {uiLoading && (
      <div className="flex min-h-dvh w-full items-center justify-center bg-slate-100">
        <div className="flex flex-col items-center gap-3">
          <div
            className="h-10 w-10 rounded-full border-2 border-slate-300 border-t-[color:#7387c9]"
            style={{ animation: "spin 0.9s linear infinite" }}
          />
          <div className="text-xs font-medium text-slate-500 text-center">
            Health Nurture is getting ready…
            <br />
            هيلث نيرتشر يقوم بالتحضير…
          </div>
        </div>
      </div>
    )}

    {!uiLoading && (
      <div className="flex min-h-dvh w-full justify-center bg-slate-100 text-slate-900">
        {/* Chat shell: fixed to viewport height, everything inside scrolls independently */}
        <div className="relative flex h-[100dvh] w-full max-w-md sm:max-w-2xl flex-col border-x border-slate-200 bg-white shadow-md overflow-hidden">
          {/* Intro modal */}
          {showIntro && (
            <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 px-4">
              <div className="w-full max-w-sm rounded-2xl bg-white p-5 ">
                <h2 className="mb-1 text-center text-lg font-semibold text-slate-900">
                  Health Nurture
                </h2>
                <p className="mb-4 text-center text-xs text-slate-600">
                  Short questions to personalize your experience.
                  <br />
                  أسئلة قصيرة لتهيئة تجربتك.
                </p>

                <div className="space-y-4 text-sm">
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Gender / الجنس
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setGender("male")}
                        className={`flex-1 rounded-full border px-3 py-2 text-xs ${
                          gender === "male"
                            ? "border-transparent text-white"
                            : "border-slate-300 text-slate-700"
                        }`}
                        style={
                          gender === "male"
                            ? { backgroundColor: primaryColor }
                            : undefined
                        }
                      >
                        Male / ذكر
                      </button>
                      <button
                        type="button"
                        onClick={() => setGender("female")}
                        className={`flex-1 rounded-full border px-3 py-2 text-xs ${
                          gender === "female"
                            ? "border-transparent text-white"
                            : "border-slate-300 text-slate-700"
                        }`}
                        style={
                          gender === "female"
                            ? { backgroundColor: secondaryColor }
                            : undefined
                        }
                      >
                        Female / أنثى
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Neighborhood / الحي
                    </label>
                    <select
                      value={neighborhood}
                      onChange={(e) => setNeighborhood(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs outline-none focus:border-[color:#7387c9] focus:ring-1 focus:ring-[color:#7387c9]"
                    >
                      <option value="">Select / اختر</option>
                      <option value="Tripoli">Tripoli / طرابلس</option>
                      <option value="Akkar">Akkar / عكار</option>
                      <option value="Bekka">Bekka / البقاع</option>
                      <option value="Beirut">Beirut / بيروت</option>
                      <option value="other">Other / أخرى</option>
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Age / العمر
                    </label>
                    <input
                      type="number"
                      min={8}
                      max={25}
                      value={age}
                      onChange={(e) => setAge(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs outline-none focus:border-[color:#7387c9] focus:ring-1 focus:ring-[color:#7387c9]"
                      placeholder="Your age / عمرك"
                    />
                  </div>
                </div>

                <button
                  type="button"
                  disabled={!introValid}
                  onClick={handleStartChat}
                  className="mt-5 flex w-full items-center justify-center rounded-full px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ backgroundColor: primaryColor }}
                >
                  Start chat / ابدأ المحادثة
                </button>
              </div>
            </div>
          )}

          {/* HEADER – sticky within chat shell (doesn't scroll with messages) */}
          <header className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
            <div className="flex flex-col">
              <span className="text-sm font-semibold tracking-wide text-slate-900">
                Health Nurture
              </span>
              <span className="text-[11px] text-slate-500">
                Sexual and Emotional Health Guide • دليل لصحتك الجنسية والعاطفية
              </span>
            </div>
          </header>

          {/* MESSAGES – the only scrollable area */}
          <main className="flex-1 overflow-y-auto bg-slate-50 px-3 py-3 sm:px-4 sm:py-4">
            <div className="flex flex-col gap-3 pb-4">
              {messages.map((msg, idx) => {
                const isUser = msg.role === "user";
                const isAssistant = msg.role === "assistant";
                const isSpeaking = speakingIndex === idx;

                return (
                  <div
                    key={idx}
                    className={`flex w-full ${
                      isUser ? "justify-end" : "justify-start"
                    }`}
                  >
                    <div
                      className={`max-w-[92%] sm:max-w-[82%] rounded-2xl px-3 py-2 text-sm transition-transform duration-150 ${
                        isUser
                          ? "rounded-br-md text-white"
                          : "rounded-bl-md border border-slate-200 bg-white text-slate-900"
                      }`}
                      style={
                        isUser ? { backgroundColor: primaryColor } : undefined
                      }
                    >
                      <div className="flex items-start gap-2">
                        <p
                          className="flex-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed"
                          dir={containsArabic(msg.content) ? "rtl" : "ltr"}
                        >
                          {msg.content} <br />
                          {isSpeaking && audioStatus && (
                            <span
                              className="text-[10px] font-medium"
                              style={{ color: secondaryColor }}
                            >
                              {audioStatus === "loading"
                                ? "(loading audio / جاري تحميل الصوت)"
                                : "(playing audio / جاري تشغيل الصوت)"}
                            </span>
                          )}
                        </p>

                        {isAssistant && (
                          <div className="flex flex-col items-end gap-1">
                            <button
                              type="button"
                              onClick={() => speakMessage(msg, idx)}
                              className={`mt-0.5 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border text-[11px] transition duration-150 ${
                                isSpeaking
                                  ? "border-transparent text-white"
                                  : "border-slate-200 text-slate-500 hover:border-slate-400 hover:text-slate-700"
                              }`}
                              style={
                                isSpeaking
                                  ? { backgroundColor: secondaryColor }
                                  : undefined
                              }
                              title={
                                isSpeaking ? "Stop" : "Listen / استمع للإجابة"
                              }
                            >
                              <IconSpeaker className="h-4 w-4" />
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="mt-1 flex items-center justify-end">
                        {msg.createdAt && (
                          <span
                            className="text-[10px] text-slate-400"
                            suppressHydrationWarning
                          >
                            {formatTime(msg.createdAt)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              {showTypingBubble && (
                <div className="flex w-full justify-start">
                  <div className="max-w-[60%] rounded-2xl rounded-bl-md border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-500">
                    <div className="flex items-center gap-1">
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:0.12s]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:0.24s]" />
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </main>

          {/* FOOTER – sticky within chat shell */}
          <footer className="shrink-0 border-t border-slate-200 bg-white px-3 py-3 sm:px-4">
            <div className="flex items-end gap-2 sm:gap-3">
              <div className="flex-1 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 transition duration-150 focus-within:border-[color:#7387c9] focus-within:ring-1 focus-within:ring-[color:#7387c9]">
                <textarea
                  className="max-h-32 min-h-[42px] w-full resize-none bg-transparent text-[16px] sm:text-[13px] leading-relaxed text-slate-900 outline-none placeholder:text-slate-400"
                  placeholder="Ask about puberty, sexual health or emotions... / اسأل عن البلوغ أو الصحة الجنسية أو المشاعر..."
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={showIntro}
                />
              </div>

              <button
                onClick={handleSend}
                disabled={
                  isSending || !input.trim() || showIntro || !!typingState
                }
                className="inline-flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold text-white transition duration-150 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ backgroundColor: primaryColor }}
                title="Send / إرسال"
              >
                <IconSend className="h-4 w-4" />
              </button>
            </div>
          </footer>
        </div>
      </div>
    )}
  </>
);
}
