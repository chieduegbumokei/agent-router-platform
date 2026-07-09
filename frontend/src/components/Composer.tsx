"use client";

import {
  AudioLines,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  FolderPlus,
  Ghost,
  Lightbulb,
  Mic,
  MicOff,
  Paperclip,
  Plug,
  Plus,
  Send,
  Settings2,
  Square,
  X,
} from "lucide-react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { apiFetch } from "@/lib/api";
import {
  isBraveBrowser,
  markRecognitionBroken,
  recognitionLikelyUsable,
  speechRecognitionCtor,
  speechSynthesisSupported,
  type SpeechRecognitionLike,
} from "@/lib/speech";
import {
  STRICTNESS_LABELS,
  type AttachmentPayload,
  type McpServer,
  type Project,
  type Strictness,
} from "@/lib/types";

const MAX_LENGTH = 8000;
/** The counter is noise until the limit is actually in sight. */
const SHOW_COUNT_AT = MAX_LENGTH * 0.8;
const WARN_COUNT_AT = MAX_LENGTH * 0.95;
const MAX_FILES = 4;
const MAX_IMAGE_BYTES = 3_500_000;
const MAX_TEXT_BYTES = 48_000;
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|csv|tsv|json|yaml|yml|xml|html?|css|js|jsx|ts|tsx|py|rb|go|rs|java|c|h|cpp|sql|sh|toml|ini|log)$/i;

const EXAMPLE_PROMPTS: Array<{ text: string; routesTo: string }> = [
  {
    text: "Write a JavaScript function that reverses a string, and verify it works",
    routesTo: "Coding Agent + code interpreter",
  },
  {
    text: "How much do I need to save monthly to reach $50k in 5 years at 4% interest?",
    routesTo: "Financial Advisor",
  },
  {
    text: "Explain how DNS resolution works, step by step",
    routesTo: "Generic Agent",
  },
];

const USAGE_TIPS: string[] = [
  'Be specific: "debug this TypeScript null error" routes and answers better than "help with code".',
  "Attach an image or a code file with the paperclip (or paste a screenshot straight in).",
  "Hover any answer to copy it, rate it, or regenerate; hover your own message to edit and branch.",
  "Pick an Answer style from the options button: Strict for facts and figures, Creative for brainstorming.",
  "Watch the Live pipeline panel to see routing, tool calls, and token usage as they happen.",
  "Long answer going the wrong way? Hit Stop (or Esc) - the partial answer is kept.",
];

interface PendingFile {
  file: File;
  kind: "image" | "text";
  previewUrl?: string;
}

async function toPayload(pending: PendingFile): Promise<AttachmentPayload> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(new Error(`could not read ${pending.file.name}`));
    reader.readAsDataURL(pending.file);
  });
  return {
    name: pending.file.name || "pasted-image.png",
    mediaType:
      pending.file.type ||
      (pending.kind === "image" ? "image/png" : "text/plain"),
    kind: pending.kind,
    size: pending.file.size,
    dataBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
  };
}

/** Root list, or one of its drilled-in submenus. */
type PlusPanel = "root" | "project" | "connectors" | "style" | "prompts";

export interface ComposerHandle {
  focus(): void;
}

interface Props {
  disabled: boolean;
  streaming: boolean;
  strictness: Strictness;
  /** Incognito mode: shown as a hint so users know nothing is being saved. */
  ephemeral: boolean;
  /** Unsent text is kept per conversation and restored when switching back. */
  draftKey: string;
  onStrictnessChange(s: Strictness): void;
  onSend(text: string, attachments: AttachmentPayload[]): void;
  onStop(): void;
  /** Opens hands-free voice mode. When absent, the voice button is not shown. */
  onVoiceMode?(): void;
  /** Projects available for "Add to project". Omit to hide that item entirely. */
  projects?: Project[];
  /** Project the current/next-sent conversation belongs to, if any. */
  currentProjectId?: string | null;
  onSelectProject?(projectId: string | null): void;
  /** Opens connector management (Settings → Connectors). Omit to hide the Connectors item. */
  onOpenConnectors?(): void;
  onManageProjects?(): void;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  {
    disabled,
    streaming,
    strictness,
    ephemeral,
    draftKey,
    onStrictnessChange,
    onSend,
    onStop,
    onVoiceMode,
    projects,
    currentProjectId = null,
    onSelectProject,
    onOpenConnectors,
    onManageProjects,
  },
  handleRef,
) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [plusPanel, setPlusPanel] = useState<PlusPanel>("root");
  const [mcpServers, setMcpServers] = useState<McpServer[] | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpBusy, setMcpBusy] = useState<string | null>(null);
  const [dictating, setDictating] = useState(false);
  const menuAreaRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const dictationBaseRef = useRef("");
  // Both resolved after mount: SSR/first-render agree (no hydration flip), and
  // we can hide voice entirely in browsers whose recognition doesn't actually work.
  const [canDictate, setCanDictate] = useState(false);
  const [canVoice, setCanVoice] = useState(false);
  // Touch keyboards use Enter for newlines; sending happens via the button.
  const [coarsePointer] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(pointer: coarse)").matches,
  );

  useImperativeHandle(
    handleRef,
    () => ({ focus: () => textareaRef.current?.focus() }),
    [],
  );

  useEffect(() => {
    const usable = recognitionLikelyUsable();
    setCanDictate(usable);
    setCanVoice(usable && speechSynthesisSupported() && Boolean(onVoiceMode));
    // Brave only reveals itself asynchronously; if detected, remember and hide.
    void isBraveBrowser().then((brave) => {
      if (brave) {
        markRecognitionBroken();
        setCanDictate(false);
        setCanVoice(false);
      }
    });
  }, [onVoiceMode]);

  // Per-conversation drafts: stash the old key's text, restore the new key's.
  const draftsRef = useRef<Map<string, string>>(new Map());
  const textRef = useRef(text);
  textRef.current = text;
  const prevKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevKeyRef.current;
    if (prev !== null && prev !== draftKey) {
      if (textRef.current) draftsRef.current.set(prev, textRef.current);
      else draftsRef.current.delete(prev);
      setText(draftsRef.current.get(draftKey) ?? "");
    }
    prevKeyRef.current = draftKey;
  }, [draftKey]);

  // Auto-grow the textarea with its content (capped by CSS max-height)
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [text]);

  function closePlusMenu() {
    setPlusOpen(false);
    setPlusPanel("root");
  }

  // Close the dropdown on outside click / Escape
  useEffect(() => {
    if (!plusOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (
        menuAreaRef.current &&
        !menuAreaRef.current.contains(e.target as Node)
      )
        closePlusMenu();
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") closePlusMenu();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [plusOpen]);

  // Fetch connectors fresh each time the Connectors panel is opened.
  useEffect(() => {
    if (plusPanel !== "connectors") return;
    let cancelled = false;
    setMcpLoading(true);
    apiFetch<{ servers: McpServer[] }>("/mcp/servers")
      .then((d) => {
        if (!cancelled) setMcpServers(d.servers);
      })
      .catch(() => {
        if (!cancelled) setMcpServers([]);
      })
      .finally(() => {
        if (!cancelled) setMcpLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [plusPanel]);

  async function toggleConnector(server: McpServer) {
    setMcpBusy(server.serverId);
    try {
      const d = await apiFetch<{ server: McpServer }>(
        `/mcp/servers/${server.serverId}`,
        { method: "PATCH", body: JSON.stringify({ enabled: !server.enabled }) },
      );
      setMcpServers(
        (prev) =>
          prev?.map((s) => (s.serverId === server.serverId ? d.server : s)) ??
          prev,
      );
    } catch {
      flagError("Could not update the connector");
    }
    setMcpBusy(null);
  }

  // Release image preview object URLs
  useEffect(
    () => () =>
      files.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl)),
    [files],
  );

  function flagError(message: string) {
    setAttachError(message);
    setTimeout(() => setAttachError(null), 4000);
  }

  function classify(file: File): PendingFile | null {
    if (IMAGE_TYPES.has(file.type)) {
      if (file.size > MAX_IMAGE_BYTES) {
        flagError(`${file.name}: images must be under 3.5MB`);
        return null;
      }
      return { file, kind: "image", previewUrl: URL.createObjectURL(file) };
    }
    if (file.type.startsWith("text/") || TEXT_EXTENSIONS.test(file.name)) {
      if (file.size > MAX_TEXT_BYTES) {
        flagError(`${file.name}: text files must be under 48KB`);
        return null;
      }
      return { file, kind: "text" };
    }
    flagError(
      `${file.name}: only images (png/jpeg/gif/webp) and text files are supported`,
    );
    return null;
  }

  function addFiles(incoming: File[]) {
    setFiles((prev) => {
      const next = [...prev];
      for (const file of incoming) {
        if (next.length >= MAX_FILES) {
          flagError(`Up to ${MAX_FILES} attachments per message`);
          break;
        }
        const classified = classify(file);
        if (classified) next.push(classified);
      }
      return next;
    });
  }

  function onPickFiles(e: ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(e.target.files ?? []));
    e.target.value = "";
  }

  /** Screenshots: paste an image anywhere in the textarea to attach it. */
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = Array.from(e.clipboardData.files ?? []);
    if (pasted.length > 0) {
      e.preventDefault();
      addFiles(pasted);
    }
  }

  function removeFile(index: number) {
    setFiles((prev) => {
      prev[index]?.previewUrl && URL.revokeObjectURL(prev[index]!.previewUrl!);
      return prev.filter((_, i) => i !== index);
    });
  }

  /** Captures a screen/window/tab via the browser's screen-share picker and attaches it as an image. */
  async function captureScreenshot() {
    closePlusMenu();
    if (!navigator.mediaDevices?.getDisplayMedia) {
      flagError("Screenshot capture isn't supported in this browser.");
      return;
    }
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("no video track");
      const video = document.createElement("video");
      video.srcObject = stream;
      await video.play();
      // Give the first frame a moment to actually paint before grabbing it.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (!blob) throw new Error("capture failed");
      addFiles([
        new File([blob], `screenshot-${Date.now()}.png`, {
          type: "image/png",
        }),
      ]);
    } catch (err) {
      if ((err as Error).name !== "NotAllowedError") {
        flagError("Could not capture a screenshot.");
      }
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
    }
  }

  function stopDictation() {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setDictating(false);
  }

  function toggleDictation() {
    if (dictating) {
      stopDictation();
      return;
    }
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    dictationBaseRef.current = text ? `${text.trimEnd()} ` : "";
    rec.onresult = (event) => {
      let transcript = "";
      for (let i = 0; i < event.results.length; i++)
        transcript += event.results[i]![0]!.transcript;
      setText(`${dictationBaseRef.current}${transcript}`.slice(0, MAX_LENGTH));
    };
    rec.onend = () => setDictating(false);
    rec.onerror = (e) => {
      setDictating(false);
      // Don't fail silently — tell the user why nothing got transcribed.
      if (typeof console !== "undefined")
        console.warn("[dictation] recognition error:", e.error);
      if (e.error === "network" || e.error === "service-not-allowed") {
        // Recognition can't reach a backend (Arc/Brave/other forks) — hide voice for good.
        markRecognitionBroken();
        setCanDictate(false);
        setCanVoice(false);
        flagError(
          "Voice input is not supported in this browser — hiding it. Use Chrome or Edge for voice.",
        );
      } else if (e.error === "not-allowed") {
        flagError(
          "Microphone access is blocked. Allow it from the address-bar mic/lock icon.",
        );
      } else if (e.error === "audio-capture") {
        flagError("No microphone was found.");
      } else if (e.error === "no-speech") {
        flagError("Didn't catch anything — try again and speak up.");
      }
    };
    recognitionRef.current = rec;
    setDictating(true);
    try {
      rec.start();
    } catch (err) {
      setDictating(false);
      if (typeof console !== "undefined")
        console.warn("[dictation] start failed:", err);
      flagError(
        "Could not start the microphone. Is the page on localhost/https and the mic free?",
      );
    }
  }

  async function submit() {
    const trimmed = text.trim();
    if ((!trimmed && files.length === 0) || disabled) return;
    if (dictating) stopDictation();
    let attachments: AttachmentPayload[] = [];
    try {
      attachments = await Promise.all(files.map(toPayload));
    } catch (err) {
      flagError((err as Error).message);
      return;
    }
    files.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    setText("");
    setFiles([]);
    draftsRef.current.delete(draftKey);
    onSend(trimmed, attachments);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !coarsePointer) {
      e.preventDefault();
      void submit();
    }
  }

  function usePrompt(promptText: string) {
    setText(promptText);
    closePlusMenu();
    textareaRef.current?.focus();
  }

  return (
    <div className="composer">
      <div className={`composer-card${ephemeral ? " ephemeral" : ""}`}>
        {files.length > 0 && (
          <div className="composer-attachments">
            {files.map((f, i) => (
              <span key={`${f.file.name}-${i}`} className="attachment-chip">
                {f.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.previewUrl} alt="" className="attachment-thumb" />
                ) : (
                  <Paperclip size={11} />
                )}
                <span className="attachment-chip-name">
                  {f.file.name || "pasted image"}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${f.file.name}`}
                  onClick={() => removeFile(i)}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        {attachError && (
          <div className="composer-attach-error">{attachError}</div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={
            dictating
              ? "Listening… speak now"
              : coarsePointer
                ? "Ask the assistant…"
                : "Ask the assistant… (Enter to send, Shift+Enter for a new line)"
          }
          rows={1}
          maxLength={MAX_LENGTH}
        />
        <div className="composer-toolbar">
          <div className="composer-toolbar-left" ref={menuAreaRef}>
            <div className="composer-menu-wrap">
              <button
                type="button"
                className={`composer-tool plus-tool${plusOpen ? " open" : ""}`}
                onClick={() =>
                  setPlusOpen((o) => {
                    const next = !o;
                    if (!next) setPlusPanel("root");
                    return next;
                  })
                }
                aria-haspopup="menu"
                aria-expanded={plusOpen}
                aria-label="Add files, projects, connectors, and options"
                title="Add files, projects, connectors, and options"
              >
                <Plus size={16} />
              </button>
              {plusOpen && (
                <div
                  className={`composer-menu plus-menu${plusPanel === "prompts" ? " prompts" : ""}`}
                  role="menu"
                  aria-label="Composer options"
                >
                  {plusPanel === "root" && (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        className="menu-row"
                        onClick={() => {
                          closePlusMenu();
                          fileRef.current?.click();
                        }}
                      >
                        <Paperclip size={15} className="menu-row-icon" />
                        <span className="menu-row-label">
                          Add files or photos
                        </span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="menu-row"
                        onClick={() => void captureScreenshot()}
                      >
                        <Camera size={15} className="menu-row-icon" />
                        <span className="menu-row-label">
                          Take a screenshot
                        </span>
                      </button>
                      {onSelectProject && (
                        <button
                          type="button"
                          role="menuitem"
                          className="menu-row"
                          onClick={() => setPlusPanel("project")}
                        >
                          <FolderPlus size={15} className="menu-row-icon" />
                          <span className="menu-row-label">
                            Add to project
                          </span>
                          <ChevronRight size={14} className="menu-row-chevron" />
                        </button>
                      )}
                      {onOpenConnectors && (
                        <>
                          <div className="menu-divider" role="separator" />
                          <button
                            type="button"
                            role="menuitem"
                            className="menu-row"
                            onClick={() => setPlusPanel("connectors")}
                          >
                            <Plug size={15} className="menu-row-icon" />
                            <span className="menu-row-label">Connectors</span>
                            <ChevronRight
                              size={14}
                              className="menu-row-chevron"
                            />
                          </button>
                        </>
                      )}
                      <div className="menu-divider" role="separator" />
                      <button
                        type="button"
                        role="menuitem"
                        className="menu-row"
                        onClick={() => setPlusPanel("style")}
                      >
                        <Settings2 size={15} className="menu-row-icon" />
                        <span className="menu-row-label">Answer style</span>
                        <span className="menu-row-trailing">
                          {STRICTNESS_LABELS[strictness].label}
                        </span>
                        <ChevronRight size={14} className="menu-row-chevron" />
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="menu-row"
                        onClick={() => setPlusPanel("prompts")}
                      >
                        <Lightbulb size={15} className="menu-row-icon" />
                        <span className="menu-row-label">Prompts & tips</span>
                        <ChevronRight size={14} className="menu-row-chevron" />
                      </button>
                    </>
                  )}

                  {plusPanel === "project" && (
                    <>
                      <button
                        type="button"
                        className="menu-back"
                        onClick={() => setPlusPanel("root")}
                      >
                        <ChevronLeft size={14} /> Add to project
                      </button>
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={!currentProjectId}
                        className="menu-option"
                        onClick={() => {
                          onSelectProject?.(null);
                          closePlusMenu();
                        }}
                      >
                        <span className="menu-option-text">
                          <span className="menu-option-label">
                            No project
                          </span>
                        </span>
                        {!currentProjectId && (
                          <Check size={15} className="menu-option-check" />
                        )}
                      </button>
                      {(projects ?? []).map((p) => (
                        <button
                          key={p.projectId}
                          type="button"
                          role="menuitemradio"
                          aria-checked={currentProjectId === p.projectId}
                          className="menu-option"
                          onClick={() => {
                            onSelectProject?.(p.projectId);
                            closePlusMenu();
                          }}
                        >
                          <span className="menu-option-text">
                            <span className="menu-option-label">
                              {p.name}
                            </span>
                          </span>
                          {currentProjectId === p.projectId && (
                            <Check size={15} className="menu-option-check" />
                          )}
                        </button>
                      ))}
                      {(projects ?? []).length === 0 && (
                        <p className="menu-empty-hint">No projects yet.</p>
                      )}
                      {onManageProjects && (
                        <>
                          <div className="menu-divider" role="separator" />
                          <button
                            type="button"
                            className="menu-row"
                            onClick={() => {
                              closePlusMenu();
                              onManageProjects();
                            }}
                          >
                            <FolderPlus size={15} className="menu-row-icon" />
                            <span className="menu-row-label">
                              Manage projects
                            </span>
                          </button>
                        </>
                      )}
                    </>
                  )}

                  {plusPanel === "connectors" && (
                    <>
                      <button
                        type="button"
                        className="menu-back"
                        onClick={() => setPlusPanel("root")}
                      >
                        <ChevronLeft size={14} /> Connectors
                      </button>
                      {mcpLoading && (
                        <p className="menu-empty-hint">Loading…</p>
                      )}
                      {!mcpLoading && (mcpServers?.length ?? 0) === 0 && (
                        <p className="menu-empty-hint">
                          No connectors yet - add an MCP server to give every
                          agent more tools.
                        </p>
                      )}
                      {!mcpLoading &&
                        mcpServers?.map((s) => (
                          <div key={s.serverId} className="mcp-mini-row">
                            <span
                              className={`status-dot ${s.status === "ok" ? "completed" : "failed"}`}
                            />
                            <span className="mcp-mini-name" title={s.url}>
                              {s.name}
                            </span>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={s.enabled}
                              aria-label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`}
                              className={`toggle sm${s.enabled ? " on" : ""}`}
                              disabled={mcpBusy === s.serverId}
                              onClick={() => void toggleConnector(s)}
                            >
                              <span className="toggle-knob" />
                            </button>
                          </div>
                        ))}
                      <div className="menu-divider" role="separator" />
                      <button
                        type="button"
                        className="menu-row"
                        onClick={() => {
                          closePlusMenu();
                          onOpenConnectors?.();
                        }}
                      >
                        <Plug size={15} className="menu-row-icon" />
                        <span className="menu-row-label">
                          Manage connectors…
                        </span>
                      </button>
                    </>
                  )}

                  {plusPanel === "style" && (
                    <>
                      <button
                        type="button"
                        className="menu-back"
                        onClick={() => setPlusPanel("root")}
                      >
                        <ChevronLeft size={14} /> Answer style
                      </button>
                      {(Object.keys(STRICTNESS_LABELS) as Strictness[]).map(
                        (s) => (
                          <button
                            key={s}
                            type="button"
                            role="menuitemradio"
                            aria-checked={strictness === s}
                            className="menu-option"
                            onClick={() => {
                              onStrictnessChange(s);
                              closePlusMenu();
                            }}
                          >
                            <span className="menu-option-text">
                              <span className="menu-option-label">
                                {STRICTNESS_LABELS[s].label}
                              </span>
                              <span className="menu-option-hint">
                                {STRICTNESS_LABELS[s].hint}
                              </span>
                            </span>
                            {strictness === s && (
                              <Check size={15} className="menu-option-check" />
                            )}
                          </button>
                        ),
                      )}
                    </>
                  )}

                  {plusPanel === "prompts" && (
                    <>
                      <button
                        type="button"
                        className="menu-back"
                        onClick={() => setPlusPanel("root")}
                      >
                        <ChevronLeft size={14} /> Prompts & tips
                      </button>
                      <div className="composer-menu-label">
                        Try one of these
                      </div>
                      {EXAMPLE_PROMPTS.map((p) => (
                        <button
                          key={p.text}
                          type="button"
                          className="tip-prompt"
                          onClick={() => usePrompt(p.text)}
                        >
                          <span className="tip-prompt-text">{p.text}</span>
                          <span className="tip-prompt-route">
                            → {p.routesTo}
                          </span>
                        </button>
                      ))}
                      <div className="composer-menu-label tips-heading">
                        Tips to get the best answers
                      </div>
                      <ul className="tips-list">
                        {USAGE_TIPS.map((t) => (
                          <li key={t}>{t}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </div>

            {canDictate && (
              <button
                type="button"
                className={`composer-tool${dictating ? " recording" : ""}`}
                onClick={toggleDictation}
                title={dictating ? "Stop dictation" : "Dictate with your voice"}
                aria-pressed={dictating}
              >
                {dictating ? <MicOff size={14} /> : <Mic size={14} />}
                <span className="composer-tool-label">
                  {dictating ? "Stop" : "Voice"}
                </span>
              </button>
            )}
          </div>
          <div className="composer-toolbar-right">
            {text.length >= SHOW_COUNT_AT && (
              <span
                className={`composer-count${text.length >= WARN_COUNT_AT ? " warn" : ""}`}
              >
                {text.length.toLocaleString("en-US")} /{" "}
                {MAX_LENGTH.toLocaleString("en-US")}
              </span>
            )}
            {streaming ? (
              <button
                type="button"
                className="composer-send stop"
                onClick={onStop}
                aria-label="Stop generating"
              >
                <Square size={13} />
              </button>
            ) : !text.trim() && files.length === 0 && canVoice ? (
              // Empty composer: offer hands-free voice mode. It gives way to Send the moment you type.
              <button
                type="button"
                className="composer-send voice"
                onClick={() => onVoiceMode?.()}
                aria-label="Start voice conversation"
                title="Voice mode"
              >
                <AudioLines size={16} />
              </button>
            ) : (
              <button
                type="button"
                className="composer-send"
                onClick={() => void submit()}
                disabled={disabled || (!text.trim() && files.length === 0)}
                aria-label="Send message"
              >
                <Send size={15} />
              </button>
            )}
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          accept="image/png,image/jpeg,image/gif,image/webp,text/*,.md,.json,.csv,.ts,.tsx,.js,.jsx,.py,.sql,.yaml,.yml,.sh,.log"
          onChange={onPickFiles}
        />
      </div>
      <div className="composer-hint">
        {ephemeral ? (
          <span className="composer-hint-ephemeral">
            <Ghost size={11} /> Incognito chat - not saved to history, memory
            stays off.
          </span>
        ) : (
          <></>
        )}{" "}
        The model can make mistakes - double-check important information.
      </div>
    </div>
  );
});
