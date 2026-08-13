import { useState, useEffect, useRef, useMemo } from "react";
import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  CodeMirrorEditor,
  useCodeBlockEditorContext,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import { $createParagraphNode } from "lexical";
import {
  saveTasks, loadTasks, saveNote, loadNote, loadNoteRaw,
  saveSettings, loadSettings, exportAllMarkdownZip,
  importMarkdownFiles, parseZip,
  saveAttachments, loadAttachments,
  weekKey, weekRange, fmtTime, tasksToMarkdown,
} from "./markdownDb.js";
import { useLayoutMode } from "./layoutMode.js";

/* ---- helpers ---- */
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const fmtDateDisplay = (iso) => {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
};
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

function ExitOnEnterCodeMirrorEditor(props) {
  const { parentEditor, lexicalNode } = useCodeBlockEditorContext();

  const handleKeyDownCapture = (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    parentEditor.update(() => {
      const paragraph = $createParagraphNode();
      lexicalNode.insertAfter(paragraph);
      paragraph.select();
    });
    requestAnimationFrame(() => parentEditor.focus());
  };

  return (
    <div onKeyDownCapture={handleKeyDownCapture}>
      <CodeMirrorEditor {...props} />
    </div>
  );
}

const exitOnEnterCodeBlockDescriptor = {
  priority: 2,
  match: () => true,
  Editor: ExitOnEnterCodeMirrorEditor,
};
const getMonday = (d) => {
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.getFullYear(), d.getMonth(), diff);
};

/* =========================================================
   AUDIO — Beeps for timer / focus / break
   ========================================================= */
function createTonePlayer() {
  let ctx = null;
  const getCtx = () => {
    if (!ctx || ctx.state === "closed") ctx = new (window.AudioContext || window.webkitAudioContext)();
    return ctx;
  };

  const playNote = (freq, startTime, duration, gain = 0.25) => {
    const c = getCtx();
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    g.gain.value = gain;
    g.gain.setValueAtTime(gain, startTime);
    g.gain.exponentialRampToValueAtTime(0.01, startTime + duration - 0.02);
    osc.connect(g);
    g.connect(c.destination);
    osc.start(startTime);
    osc.stop(startTime + duration);
  };

  const playBeeps = (count, { freq, duration, gap, gain = 0.25 }) => {
    try {
      const c = getCtx();
      const now = c.currentTime;
      for (let i = 0; i < count; i++) {
        playNote(freq, now + i * gap, duration, gain);
      }
    } catch (e) {}
  };

  return {
    // 300s timer complete: 3 beeps
    timerComplete: () => {
      playBeeps(3, { freq: 138.59, duration: 0.28, gap: 0.38, gain: 0.28 });
    },

    // Focus track complete: 5 small beeps
    pomodoroComplete: () => {
      playBeeps(5, { freq: 233.08, duration: 0.1, gap: 0.16, gain: 0.2 });
    },

    // Break complete: 2 small beeps
    breakComplete: () => {
      playBeeps(2, { freq: 329.63, duration: 0.1, gap: 0.16, gain: 0.2 });
    },
  };
}

const audio = createTonePlayer();
const DragCtx = { dragIdx: null };

const NAV_COLUMNS = ["tasks", "widgets", "attachments", "completed"];

function isTypingTarget(el) {
  if (!el || !(el instanceof Element)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!el.isContentEditable;
}

/* Reusable play/pause control — same look for 300s timer and pomodoro */
function PlayPauseButton({ running, onToggle, style, id, className = "", ariaLabel = "Toggle timer" }) {
  return (
    <button
      id={id}
      className={`calendar-task-app__timer-toggle ${className}`.trim()}
      type="button"
      onClick={onToggle}
      aria-label={ariaLabel}
      aria-pressed={running}
      style={{
        background: running ? "rgba(239,68,68,0.25)" : "rgba(34,197,94,0.25)",
        border: `1px solid ${running ? "rgba(239,68,68,0.5)" : "rgba(34,197,94,0.5)"}`,
        borderRadius: 6,
        padding: "5px 14px",
        color: "#e2e8f0",
        cursor: "pointer",
        fontSize: 16,
        fontWeight: 600,
        fontFamily: "inherit",
        flexShrink: 0,
        lineHeight: 1,
        transition: "all 0.15s",
        ...style,
      }}
    >
      {running ? "\u23F8" : "\u25B6"}
    </button>
  );
}

const DIALOG_STYLE = {
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, backdropFilter: "blur(4px)" },
  box: { background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: 22, maxWidth: 400, width: "90%" },
  btn: (bg) => ({ background: bg || "rgba(255,255,255,0.08)", border: "none", borderRadius: 6, padding: "6px 12px", color: "#e2e8f0", cursor: "pointer", fontSize: 10, fontWeight: 600, fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace", transition: "all 0.15s" }),
};

/** Accessible confirm dialog: Tab cycles actions, Enter activates focused button, Escape cancels. */
function ConfirmDialog({
  dialogId = "confirm-dialog",
  title,
  children,
  confirmLabel,
  confirmStyle,
  onConfirm,
  onCancel,
  initialFocus = "confirm",
}) {
  const cancelRef = useRef(null);
  const confirmRef = useRef(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const prev = document.activeElement;
    const initial = initialFocus === "cancel" ? cancelRef.current : confirmRef.current;
    initial?.focus();

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancelRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = [cancelRef.current, confirmRef.current].filter(Boolean);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first || !focusables.includes(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last || !focusables.includes(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, [initialFocus]);

  return (
    <div
      id={`${dialogId}-overlay`}
      className="calendar-task-app__modal-overlay"
      style={DIALOG_STYLE.overlay}
      onClick={onCancel}
    >
      <div
        id={dialogId}
        className="calendar-task-app__modal calendar-task-app__confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${dialogId}-title`}
        aria-describedby={`${dialogId}-description`}
        style={DIALOG_STYLE.box}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={`${dialogId}-title`} className="calendar-task-app__modal-title" style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>{title}</h2>
        <div id={`${dialogId}-description`} className="calendar-task-app__modal-description">
          {children}
        </div>
        <div className="calendar-task-app__modal-actions" style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            ref={cancelRef}
            className="calendar-task-app__button calendar-task-app__button--cancel"
            type="button"
            style={DIALOG_STYLE.btn()}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            className="calendar-task-app__button calendar-task-app__button--confirm"
            type="button"
            style={{ ...DIALOG_STYLE.btn(), ...confirmStyle }}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Mobile image-source chooser: camera capture and gallery selection use separate inputs. */
function AttachmentSourceDialog({ onCamera, onGallery, onCancel }) {
  const cameraRef = useRef(null);
  const galleryRef = useRef(null);
  const cancelRef = useRef(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const previousFocus = document.activeElement;
    cameraRef.current?.focus();
    const focusables = [cameraRef.current, galleryRef.current, cancelRef.current];

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancelRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  return (
    <div
      id="attachment-source-dialog-overlay"
      className="calendar-task-app__modal-overlay calendar-task-app__attachment-source-overlay"
      style={DIALOG_STYLE.overlay}
      onClick={onCancel}
    >
      <div
        id="attachment-source-dialog"
        className="calendar-task-app__modal calendar-task-app__attachment-source-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="attachment-source-dialog-title"
        aria-describedby="attachment-source-dialog-description"
        style={{ ...DIALOG_STYLE.box, maxWidth: 340 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="attachment-source-dialog-title" className="calendar-task-app__modal-title" style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
          Add image
        </h2>
        <p id="attachment-source-dialog-description" className="calendar-task-app__modal-description" style={{ margin: "0 0 14px", fontSize: 10, color: "rgba(255,255,255,0.55)" }}>
          Choose a camera capture or an existing image.
        </p>
        <div className="calendar-task-app__attachment-source-actions" style={{ display: "grid", gap: 8 }}>
          <button
            ref={cameraRef}
            id="attachment-source-camera"
            className="calendar-task-app__button calendar-task-app__attachment-source-button"
            type="button"
            style={{ ...DIALOG_STYLE.btn("rgba(59,130,246,0.18)"), border: "1px solid rgba(59,130,246,0.4)", width: "100%" }}
            onClick={onCamera}
          >
            {"\uD83D\uDCF7"} Camera
          </button>
          <button
            ref={galleryRef}
            id="attachment-source-gallery"
            className="calendar-task-app__button calendar-task-app__attachment-source-button"
            type="button"
            style={{ ...DIALOG_STYLE.btn("rgba(168,85,247,0.18)"), border: "1px solid rgba(168,85,247,0.4)", width: "100%" }}
            onClick={onGallery}
          >
            {"\uD83D\uDDBC\uFE0F"} Gallery
          </button>
          <button
            ref={cancelRef}
            id="attachment-source-cancel"
            className="calendar-task-app__button calendar-task-app__attachment-source-cancel"
            type="button"
            style={{ ...DIALOG_STYLE.btn(), width: "100%" }}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   MAIN APP
   ========================================================= */
export default function CalendarTaskApp() {
  /* -- core state -- */
  const [tasks, setTasks] = useState([]);
  const [completedTasks, setCompletedTasks] = useState({});
  const [selectedDate, setSelectedDate] = useState(todayStr());
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [nextTaskId, setNextTaskId] = useState(0);
  const [nextAttId, setNextAttId] = useState(0);

  /* timer (300s) — independent of pomodoro */
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [timerRunning, setTimerRunning] = useState(false);
  const timerRef = useRef(null);
  const timerWasRunningRef = useRef(false);

  /* pomodoro — own running state, does not drive the 300s timer */
  const [pomodoroSeconds, setPomodoroSeconds] = useState(0);
  const [pomodoroPhase, setPomodoroPhase] = useState("work");
  const [pomodoroCount, setPomodoroCount] = useState(0);
  const [pomodoroRunning, setPomodoroRunning] = useState(false);
  const [focusSoundEnabled, setFocusSoundEnabled] = useState(true);
  const [breakSoundEnabled, setBreakSoundEnabled] = useState(true);
  const pomodoroRef = useRef(null);
  const lastTimerTickTime = useRef(null);
  const lastPomodoroTickTime = useRef(null);
  const focusSoundEnabledRef = useRef(true);
  const breakSoundEnabledRef = useRef(true);
  focusSoundEnabledRef.current = focusSoundEnabled;
  breakSoundEnabledRef.current = breakSoundEnabled;

  /* notes + attachments (per-week) */
  // MDXEditor treats `markdown` as its initial value. Loading notes here,
  // rather than after the editor mounts, prevents it from initializing with
  // an empty document and persisting that value over an existing note.
  const [noteContent, setNoteContent] = useState(() => loadNote(todayStr()));
  const [notesWeekKey, setNotesWeekKey] = useState(() => weekKey(todayStr()));
  const [notesEditorVersion, setNotesEditorVersion] = useState(0);
  const [attachments, setAttachments] = useState(() => loadAttachments(todayStr()));
  const [selectedAttId, setSelectedAttId] = useState(null);
  const fileRef = useRef(null);
  const cameraFileRef = useRef(null);
  const [editingAttName, setEditingAttName] = useState(null);

  /* calendar */
  const [calMonth, setCalMonth] = useState(new Date().getMonth());
  const [calYear, setCalYear] = useState(new Date().getFullYear());

  /* UI */
  const [editingDesc, setEditingDesc] = useState(null);
  const [expandedNotes, setExpandedNotes] = useState({});
  const [deleteDialog, setDeleteDialog] = useState(null);
  const [completeDialog, setCompleteDialog] = useState(null);
  const [deleteAttDialog, setDeleteAttDialog] = useState(null);
  const [attachmentSourceOpen, setAttachmentSourceOpen] = useState(false);
  const [showTasksMd, setShowTasksMd] = useState(false);
  const [notesEditorOpen, setNotesEditorOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState({
    tasks: true,
    widgets: true,
    attachments: true,
    completed: true,
  });
  const [zoomAtt, setZoomAtt] = useState(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [importMsg, setImportMsg] = useState(null);
  const importRef = useRef(null);
  const [isToday, setIsToday] = useState(true);
  const [soundDemoOpen, setSoundDemoOpen] = useState(false);
  const syncClickRef = useRef({ count: 0, timer: null });
  const modalRef = useRef(null);
  const modalInitialFocusRef = useRef(null);
  const modalRestoreFocusRef = useRef(null);

  /* responsive: columns vs stacked rows (see layoutMode.js) */
  const { isStacked: isMobile } = useLayoutMode();

  /* column / list keyboard navigation */
  const [navColumn, setNavColumn] = useState("tasks");
  const [focusedTaskIdx, setFocusedTaskIdx] = useState(0);
  const [focusedAttIdx, setFocusedAttIdx] = useState(0);
  const [focusedCompletedIdx, setFocusedCompletedIdx] = useState(0);
  const taskCardRefs = useRef([]);
  const attCardRefs = useRef([]);
  const completedCardRefs = useRef([]);
  const attachmentsPanelToggleRef = useRef(null);
  const widgetsColRef = useRef(null);
  const navColumnRef = useRef(navColumn);
  navColumnRef.current = navColumn;
  const focusedTaskIdxRef = useRef(focusedTaskIdx);
  focusedTaskIdxRef.current = focusedTaskIdx;
  const focusedAttIdxRef = useRef(focusedAttIdx);
  focusedAttIdxRef.current = focusedAttIdx;
  const focusedCompletedIdxRef = useRef(focusedCompletedIdx);
  focusedCompletedIdxRef.current = focusedCompletedIdx;

  /* ═══ HYDRATION & SYNC ═══ */
  const hydrated = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [lastSynced, setLastSynced] = useState(null);

  useEffect(() => {
    const { activeTasks, completedTasks: ct } = loadTasks();
    const settings = loadSettings();
    setTasks(activeTasks);
    setCompletedTasks(ct);
    setNextTaskId(settings.nextTaskId ?? (activeTasks.length ? Math.max(...activeTasks.map((t) => t.id)) + 1 : 0));
    setNextAttId(settings.nextAttId ?? 0);
    setPomodoroCount(settings.pomodoroCount ?? 0);
    setFocusSoundEnabled(settings.focusSoundEnabled !== false);
    setBreakSoundEnabled(settings.breakSoundEnabled !== false);
    const td = todayStr();
    setNoteContent(loadNote(td));
    setAttachments(loadAttachments(td));
    setNotesWeekKey(weekKey(td));
    setLastSynced(new Date());
    requestAnimationFrame(() => { hydrated.current = true; });
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    setDirty(true);
  }, [tasks, completedTasks, noteContent, attachments, nextTaskId, nextAttId, pomodoroCount, focusSoundEnabled, breakSoundEnabled]);

  const syncToStorage = () => {
    saveTasks(tasks, completedTasks);
    saveSettings({ nextTaskId, nextAttId, pomodoroCount, focusSoundEnabled, breakSoundEnabled });
    saveAttachments(selectedDate, attachments);
    setDirty(false);
    setLastSynced(new Date());
  };

  useEffect(() => {
    if (!hydrated.current) return;
    const iv = setInterval(() => { if (dirty) syncToStorage(); }, 10000);
    return () => clearInterval(iv);
  });

  useEffect(() => {
    const handler = () => { if (hydrated.current) syncToStorage(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  });

  /* track isToday */
  useEffect(() => {
    setIsToday(selectedDate === todayStr());
  }, [selectedDate]);

  /* ═══ 300s TIMER (task time) — wall-clock based ═══ */
  useEffect(() => {
    if (!timerRunning) return;
    if (!lastTimerTickTime.current) lastTimerTickTime.current = Date.now();

    timerRef.current = setInterval(() => {
      const now = Date.now();
      const delta = Math.floor((now - lastTimerTickTime.current) / 1000);
      if (delta < 1) return; // not a full second yet
      lastTimerTickTime.current += delta * 1000; // advance by exact seconds to prevent drift

      setTimerSeconds((prev) => {
        const next = prev + delta;
        if (next >= 300) {
          audio.timerComplete();
          return next % 300; // carry remainder
        }
        return next;
      });

      setTasks((prev) =>
        prev.map((t) => t.id === selectedTaskId ? { ...t, timeOnTask: t.timeOnTask + delta } : t)
      );
    }, 250); // catches up quickly after background

    return () => { clearInterval(timerRef.current); };
  }, [timerRunning, selectedTaskId]);

  /* Flush the latest task state whenever a 300s timer cycle rolls over. */
  useEffect(() => {
    if (!hydrated.current) return;
    if (timerRunning && timerSeconds === 0 && timerWasRunningRef.current) {
      syncToStorage();
    }
    timerWasRunningRef.current = timerRunning;
  }, [timerRunning, timerSeconds]);

  /* ═══ POMODORO (independent) — wall-clock based ═══ */
  useEffect(() => {
    if (!pomodoroRunning) return;
    if (!lastPomodoroTickTime.current) lastPomodoroTickTime.current = Date.now();

    pomodoroRef.current = setInterval(() => {
      const now = Date.now();
      const delta = Math.floor((now - lastPomodoroTickTime.current) / 1000);
      if (delta < 1) return; // not a full second yet
      lastPomodoroTickTime.current += delta * 1000; // advance by exact seconds to prevent drift

      setPomodoroPhase((phase) => {
        if (phase === "breakPending") return phase;

        setPomodoroSeconds((ps) => {
          const limit = phase === "work" ? 1500 : 300;
          const next = ps + delta;
          if (next >= limit) {
            lastPomodoroTickTime.current = null;
            if (phase === "work") {
              if (focusSoundEnabledRef.current) audio.pomodoroComplete();
              setPomodoroRunning(false);
              setPomodoroPhase("breakPending");
              setPomodoroCount((c) => c + 1);
              return 0;
            }
            if (breakSoundEnabledRef.current) audio.breakComplete();
            setPomodoroRunning(false);
            setPomodoroPhase("work");
            return 0;
          }
          return next;
        });

        return phase;
      });
    }, 250); // catches up quickly after background

    return () => clearInterval(pomodoroRef.current);
  }, [pomodoroRunning]);

  const toggleTimer = () => {
    if (timerRunning) lastTimerTickTime.current = null;
    setTimerRunning((r) => !r);
    syncToStorage();
  };

  const togglePomodoro = () => {
    if (!pomodoroRunning && pomodoroPhase === "breakPending") {
      setPomodoroPhase("break");
      setPomodoroSeconds(0);
    }
    if (pomodoroRunning) lastPomodoroTickTime.current = null;
    setPomodoroRunning((r) => !r);
    syncToStorage();
  };

  /** Triple-click SYNC to toggle the sound demo panel (still syncs each click). */
  const handleSyncClick = () => {
    syncToStorage();
    const ref = syncClickRef.current;
    clearTimeout(ref.timer);
    ref.count += 1;
    if (ref.count >= 3) {
      ref.count = 0;
      setSoundDemoOpen((v) => !v);
      return;
    }
    ref.timer = setTimeout(() => { ref.count = 0; }, 500);
  };

  /* ═══ TASK ACTIONS ═══ */
  const addTask = () => {
    const id = nextTaskId;
    setNextTaskId((n) => n + 1);
    setTasks((prev) => [...prev, { id, description: "", timeOnTask: 0, startDate: new Date().toISOString(), endDate: null, notes: "" }]);
    setTimeout(() => setEditingDesc(id), 50);
  };
  const confirmDelete = () => {
    if (!deleteDialog) return;
    setTasks((prev) => prev.filter((t) => t.id !== deleteDialog.id));
    if (selectedTaskId === deleteDialog.id) setSelectedTaskId(null);
    setExpandedNotes((prev) => {
      const next = { ...prev };
      delete next[deleteDialog.id];
      return next;
    });
    setDeleteDialog(null);
  };
  const confirmComplete = () => {
    if (!completeDialog) return;
    const task = completeDialog;
    const dateKey = todayStr();
    const entry = { id: task.id, description: task.description, timeOnTask: task.timeOnTask, notes: task.notes || "", completedAt: new Date().toISOString(), dateKey };
    setCompletedTasks((prev) => ({ ...prev, [dateKey]: [...(prev[dateKey] || []), entry] }));
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    if (selectedTaskId === task.id) setSelectedTaskId(null);
    setExpandedNotes((prev) => {
      const next = { ...prev };
      delete next[task.id];
      return next;
    });
    setCompleteDialog(null);
  };
  const toggleTaskNotes = (id, e) => {
    e.stopPropagation();
    setExpandedNotes((prev) => ({ ...prev, [id]: !prev[id] }));
  };
  const togglePanel = (panel) => {
    setPanelOpen((prev) => ({ ...prev, [panel]: !prev[panel] }));
  };
  const updateTaskNotes = (id, notes) => {
    setTasks((prev) => prev.map((t) => t.id === id ? { ...t, notes } : t));
  };
  const updateCompletedNotes = (dateKey, completedAt, id, notes) => {
    setCompletedTasks((prev) => ({
      ...prev,
      [dateKey]: (prev[dateKey] || []).map((ct) =>
        ct.id === id && ct.completedAt === completedAt ? { ...ct, notes } : ct
      ),
    }));
  };

  /* ═══ ATTACHMENTS ═══ */
  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !["image/png", "image/jpeg"].includes(file.type)) return;
    const reader = new FileReader();
    reader.onload = () => {
      const id = nextAttId;
      setNextAttId((n) => n + 1);
      setAttachments((prev) => [...prev, { id, name: file.name, mimeType: file.type, dataUri: reader.result, createdAt: new Date().toISOString() }]);
    };
    reader.readAsDataURL(file);
  };
  const openAttachmentPicker = () => {
    if (isMobile) {
      setAttachmentSourceOpen(true);
      return;
    }
    fileRef.current?.click();
  };
  const chooseAttachmentSource = (source) => {
    setAttachmentSourceOpen(false);
    requestAnimationFrame(() => {
      const input = source === "camera" ? cameraFileRef.current : fileRef.current;
      input?.click();
    });
  };
  const confirmDeleteAtt = () => {
    if (!deleteAttDialog) return;
    setAttachments((prev) => prev.filter((a) => a.id !== deleteAttDialog.id));
    if (selectedAttId === deleteAttDialog.id) setSelectedAttId(null);
    setDeleteAttDialog(null);
  };
  const rememberModalFocus = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) modalRestoreFocusRef.current = active;
  };
  const openZoom = (att) => {
    rememberModalFocus();
    setZoomAtt(att);
    setZoomLevel(1);
  };
  const openTasksMarkdown = () => {
    rememberModalFocus();
    setShowTasksMd(true);
  };

  /* ═══ DRAG ═══ */
  const onDragStart = (idx) => { DragCtx.dragIdx = idx; };
  const onDragOver = (e) => { e.preventDefault(); };
  const onDrop = (e, idx) => {
    e.preventDefault();
    const from = DragCtx.dragIdx;
    if (from === null || from === idx) return;
    setTasks((prev) => { const arr = [...prev]; const [item] = arr.splice(from, 1); arr.splice(idx, 0, item); return arr; });
    DragCtx.dragIdx = null;
  };

  /* ═══ CALENDAR ═══ */
  const calDays = useMemo(() => {
    const first = new Date(calYear, calMonth, 1);
    let startDay = first.getDay() - 1;
    if (startDay < 0) startDay = 6;
    const total = daysInMonth(calYear, calMonth);
    const cells = [];
    for (let i = 0; i < startDay; i++) cells.push(null);
    for (let d = 1; d <= total; d++) cells.push(d);
    return cells;
  }, [calYear, calMonth]);

  const isCurrentWeek = (day) => {
    if (!day) return false;
    const d = new Date(calYear, calMonth, day);
    const monday = getMonday(new Date());
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    return d >= monday && d <= sunday;
  };
  const isSelectedWeek = (day) => {
    if (!day) return false;
    return getMonday(new Date(calYear, calMonth, day)).toDateString() === getMonday(new Date(selectedDate + "T12:00:00")).toDateString();
  };
  const isDaySelected = (day) => {
    if (!day) return false;
    const sel = selectedDate.split("-");
    return Number(sel[0]) === calYear && Number(sel[1]) - 1 === calMonth && Number(sel[2]) === day;
  };
  const selectDate = (nextDate) => {
    if (nextDate === selectedDate) return;

    if (weekKey(nextDate) !== weekKey(selectedDate)) {
      // Notes are saved by handleNoteChange, so date changes only load data.
      // Keeping writes out of this transition prevents stale editor state
      // from being copied into another week's storage key.
      saveAttachments(selectedDate, attachments);
      setNoteContent(loadNote(nextDate));
      setAttachments(loadAttachments(nextDate));
      setNotesWeekKey(weekKey(nextDate));
      setSelectedAttId(null);
    }

    setSelectedDate(nextDate);
  };
  const selectDay = (day) => {
    if (!day) return;
    selectDate(calYear + "-" + String(calMonth + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0"));
  };
  const calendarDayIso = (day) => (
    day
      ? `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
      : null
  );
  const calendarDayLabel = (day) => {
    const iso = calendarDayIso(day);
    if (!iso) return "";
    const label = new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    const state = [
      iso === selectedDate ? "selected" : "",
      iso === todayStr() ? "today" : "",
      isSelectedWeek(day) ? "in selected week" : "",
    ].filter(Boolean);
    return state.length ? `${label}, ${state.join(", ")}` : label;
  };
  const goToday = () => {
    const td = todayStr();
    selectDate(td);
    const d = new Date();
    setCalMonth(d.getMonth());
    setCalYear(d.getFullYear());
  };
  const prevMonth = () => { if (calMonth === 0) { setCalMonth(11); setCalYear((y) => y - 1); } else setCalMonth((m) => m - 1); };
  const nextMonth = () => { if (calMonth === 11) { setCalMonth(0); setCalYear((y) => y + 1); } else setCalMonth((m) => m + 1); };

  /* ═══ EXPORT / IMPORT ═══ */
  const handleExport = () => {
    syncToStorage();
    const blob = exportAllMarkdownZip(tasks, completedTasks);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "calendar-export.zip";
    a.click();
    URL.revokeObjectURL(url);
  };
  const handleImport = async (e) => {
    const fileList = [...(e.target.files || [])];
    e.target.value = "";
    if (!fileList.length) return;

    try {
      let files = [];
      const zipFile = fileList.find((f) => /\.zip$/i.test(f.name) || f.type === "application/zip");

      if (zipFile) {
        files = await parseZip(await zipFile.arrayBuffer());
      } else {
        files = await Promise.all(fileList.map(async (f) => ({
          name: f.webkitRelativePath || f.name,
          content: await f.text(),
        })));
      }

      const { tasksResult, notesImported } = importMarkdownFiles(files);
      if (!tasksResult && notesImported === 0) {
        setImportMsg("Expected calendar-export.zip, tasks.md, or notes/YYYY-Www.md");
        setTimeout(() => setImportMsg(null), 3000);
        return;
      }

      if (tasksResult) {
        const { activeTasks, completedTasks: ct } = tasksResult;
        setTasks(activeTasks);
        setCompletedTasks(ct);
        const maxId = Math.max(
          0,
          ...activeTasks.map((t) => t.id),
          ...Object.values(ct).flat().map((t) => t.id),
        );
        setNextTaskId(maxId + 1);
      }
      if (notesImported > 0) {
        setNoteContent(loadNote(selectedDate));
        setNotesEditorVersion((version) => version + 1);
      }

      const parts = [];
      if (tasksResult) {
        parts.push(
          `${tasksResult.activeTasks.length} active`,
          `${Object.values(tasksResult.completedTasks).flat().length} completed`,
        );
      }
      if (notesImported > 0) parts.push(`${notesImported} note week${notesImported === 1 ? "" : "s"}`);
      setImportMsg("Imported " + parts.join(", "));
      setTimeout(() => setImportMsg(null), 3000);
    } catch (err) {
      setImportMsg(err?.message || "Import failed");
      setTimeout(() => setImportMsg(null), 4000);
    }
  };

  /* ═══ DERIVED ═══ */
  const filteredCompleted = completedTasks[selectedDate] || [];
  const selectedAtt = attachments.find((a) => a.id === selectedAttId);
  const currentWeekKey = weekKey(selectedDate);
  const currentWeekRange = weekRange(selectedDate);
  const pomodoroLabel = pomodoroPhase === "breakPending" ? "Break Pending" : pomodoroPhase === "break" ? "Break" : "Focus";
  const circles = useMemo(() => { const arr = []; for (let i = 0; i < 300; i++) arr.push(i < timerSeconds); return arr; }, [timerSeconds]);

  const handleNoteChange = (markdown, initialMarkdownNormalize) => {
    // MDXEditor can emit an internal normalization update as it mounts.
    // The saved source remains authoritative until the user edits it.
    if (initialMarkdownNormalize) return;
    if (notesWeekKey !== weekKey(selectedDate)) return;
    setNoteContent(markdown);
    saveNote(selectedDate, markdown);
  };

  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const filteredCompletedRef = useRef(filteredCompleted);
  filteredCompletedRef.current = filteredCompleted;
  const overlayOpenRef = useRef(false);
  overlayOpenRef.current = !!(deleteDialog || completeDialog || deleteAttDialog || attachmentSourceOpen || zoomAtt || showTasksMd);

  useEffect(() => {
    const modalIsOpen = Boolean(zoomAtt) || showTasksMd;
    if (!modalIsOpen) return undefined;

    const previousFocus = modalRestoreFocusRef.current;
    const modal = modalRef.current;
    const focusableSelector = [
      "button:not([disabled])",
      "[href]",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (zoomAtt) setZoomAtt(null);
        if (showTasksMd) setShowTasksMd(false);
        return;
      }
      if (e.key !== "Tab" || !modal) return;

      const focusables = [...modal.querySelectorAll(focusableSelector)];
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    };

    const frame = requestAnimationFrame(() => modalInitialFocusRef.current?.focus());
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey, true);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
      modalRestoreFocusRef.current = null;
    };
  }, [Boolean(zoomAtt), showTasksMd]);

  const focusTaskAt = (idx) => {
    const list = tasksRef.current;
    setNavColumn("tasks");
    if (!list.length) return;
    const i = Math.max(0, Math.min(list.length - 1, idx));
    setFocusedTaskIdx(i);
    requestAnimationFrame(() => {
      const el = taskCardRefs.current[i];
      el?.focus();
      el?.scrollIntoView({ block: "nearest" });
    });
  };
  const focusAttAt = (idx) => {
    const list = attachmentsRef.current;
    setNavColumn("attachments");
    if (!list.length) {
      requestAnimationFrame(() => document.querySelector('[data-nav-column="attachments"]')?.focus());
      return;
    }
    const i = Math.max(0, Math.min(list.length - 1, idx));
    setFocusedAttIdx(i);
    setSelectedAttId(list[i].id);
    requestAnimationFrame(() => {
      const el = attCardRefs.current[i];
      el?.focus();
      el?.scrollIntoView({ block: "nearest" });
    });
  };
  const focusCompletedAt = (idx) => {
    const list = filteredCompletedRef.current;
    setNavColumn("completed");
    if (!list.length) {
      requestAnimationFrame(() => document.querySelector('[data-nav-column="completed"]')?.focus());
      return;
    }
    const i = Math.max(0, Math.min(list.length - 1, idx));
    setFocusedCompletedIdx(i);
    requestAnimationFrame(() => {
      const el = completedCardRefs.current[i];
      el?.focus();
      el?.scrollIntoView({ block: "nearest" });
    });
  };
  const focusNavColumn = (col) => {
    setNavColumn(col);
    requestAnimationFrame(() => {
      if (col === "tasks") {
        if (tasksRef.current.length) focusTaskAt(focusedTaskIdxRef.current);
        else document.querySelector('[data-nav-column="tasks"]')?.focus();
      } else if (col === "attachments") {
        if (attachmentsRef.current.length) focusAttAt(focusedAttIdxRef.current);
        else document.querySelector('[data-nav-column="attachments"]')?.focus();
      } else if (col === "completed") {
        if (filteredCompletedRef.current.length) focusCompletedAt(focusedCompletedIdxRef.current);
        else document.querySelector('[data-nav-column="completed"]')?.focus();
      } else if (col === "widgets") {
        widgetsColRef.current?.focus();
      }
    });
  };
  const handleNotesEditorKeyDown = (e) => {
    const editor = e.currentTarget.querySelector('[contenteditable="true"]');
    const selection = window.getSelection();
    const atStart = editor && selection?.rangeCount > 0 && selection.isCollapsed && editor.contains(selection.anchorNode)
      && (() => {
        const edge = document.createRange();
        edge.selectNodeContents(editor);
        edge.collapse(true);
        return selection.getRangeAt(0).compareBoundaryPoints(Range.START_TO_START, edge) === 0;
      })();
    const atEnd = editor && selection?.rangeCount > 0 && selection.isCollapsed && editor.contains(selection.anchorNode)
      && (() => {
        const edge = document.createRange();
        edge.selectNodeContents(editor);
        edge.collapse(false);
        return selection.getRangeAt(0).compareBoundaryPoints(Range.END_TO_END, edge) === 0;
      })();

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      attachmentsPanelToggleRef.current?.focus();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        attachmentsPanelToggleRef.current?.focus();
      } else {
        document.querySelector("[data-notes-export]")?.focus();
      }
      return;
    }
    if ((e.key === "ArrowLeft" && (atStart || e.altKey)) || (e.key === "ArrowRight" && (atEnd || e.altKey))) {
      e.preventDefault();
      e.stopPropagation();
      focusNavColumn(e.key === "ArrowLeft" ? "widgets" : "completed");
    }
  };

  const focusTaskAtRef = useRef(focusTaskAt);
  focusTaskAtRef.current = focusTaskAt;
  const focusAttAtRef = useRef(focusAttAt);
  focusAttAtRef.current = focusAttAt;
  const focusCompletedAtRef = useRef(focusCompletedAt);
  focusCompletedAtRef.current = focusCompletedAt;
  const focusNavColumnRef = useRef(focusNavColumn);
  focusNavColumnRef.current = focusNavColumn;

  useEffect(() => {
    if (focusedTaskIdx >= tasks.length) setFocusedTaskIdx(Math.max(0, tasks.length - 1));
  }, [tasks.length, focusedTaskIdx]);
  useEffect(() => {
    if (focusedAttIdx >= attachments.length) setFocusedAttIdx(Math.max(0, attachments.length - 1));
  }, [attachments.length, focusedAttIdx]);
  useEffect(() => {
    if (focusedCompletedIdx >= filteredCompleted.length) setFocusedCompletedIdx(Math.max(0, filteredCompleted.length - 1));
  }, [filteredCompleted.length, focusedCompletedIdx]);

  useEffect(() => {
    const onKey = (e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      if (overlayOpenRef.current) return;
      if (isTypingTarget(e.target)) return;

      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        const cur = NAV_COLUMNS.indexOf(navColumnRef.current);
        const next = NAV_COLUMNS[(cur + dir + NAV_COLUMNS.length) % NAV_COLUMNS.length];
        focusNavColumnRef.current(next);
        return;
      }

      const col = navColumnRef.current;
      if (col === "tasks" && tasksRef.current.length) {
        e.preventDefault();
        focusTaskAtRef.current(focusedTaskIdxRef.current + (e.key === "ArrowDown" ? 1 : -1));
      } else if (col === "attachments" && attachmentsRef.current.length) {
        e.preventDefault();
        focusAttAtRef.current(focusedAttIdxRef.current + (e.key === "ArrowDown" ? 1 : -1));
      } else if (col === "completed" && filteredCompletedRef.current.length) {
        e.preventDefault();
        focusCompletedAtRef.current(focusedCompletedIdxRef.current + (e.key === "ArrowDown" ? 1 : -1));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  /* ═══ STYLES ═══ */
  const S = {
    app: {
      display: "flex",
      flexDirection: isMobile ? "column" : "row",
      height: "100dvh",
      minHeight: "100dvh",
      maxHeight: "100dvh",
      width: "100%",
      position: "fixed",
      inset: 0,
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
      background: "#0a0f1a",
      color: "#e2e8f0",
      overflow: isMobile ? "auto" : "hidden",
      overscrollBehavior: "contain",
      fontSize: 13,
    },
    col: {
      flex: isMobile ? "0 0 auto" : 1,
      display: "flex",
      flexDirection: "column",
      width: isMobile ? "100%" : undefined,
      minHeight: isMobile ? "auto" : 0,
      padding: "10px 10px",
      overflow: isMobile ? "visible" : "hidden",
      borderRight: isMobile ? "none" : "1px dashed rgba(255,255,255,0.08)",
      borderBottom: isMobile ? "1px dashed rgba(255,255,255,0.08)" : "none",
    },
    colScroll: {
      flex: isMobile ? "0 0 auto" : 1,
      overflowY: isMobile ? "visible" : "auto",
      overflowX: "hidden",
      padding: "2px 4px 2px 2px",
    },
    colTitle: { fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 2.5, marginBottom: 10, color: "rgba(255,255,255,0.3)", textAlign: "center" },
    taskCard: (sel) => ({ background: sel ? "linear-gradient(135deg, #166534, #15803d)" : "rgba(22,101,52,0.12)", border: sel ? "1px solid #22c55e" : "1px solid rgba(34,197,94,0.25)", borderRadius: 8, padding: "9px 11px", marginBottom: 6, cursor: "pointer", transition: "all 0.15s", color: sel ? "#fff" : "#86efac" }),
    completedCard: { background: "linear-gradient(135deg, #166534, #15803d)", border: "1px solid #22c55e", borderRadius: 8, padding: "9px 11px", marginBottom: 6, color: "#fff" },
    badge: { fontSize: 10, fontWeight: 800, opacity: 0.7, marginBottom: 1 },
    time: { fontSize: 16, fontWeight: 700, fontVariantNumeric: "tabular-nums" },
    desc: { fontSize: 11, opacity: 0.85, marginTop: 2 },
    btn: (bg) => ({ background: bg || "rgba(255,255,255,0.08)", border: "none", borderRadius: 6, padding: "6px 12px", color: "#e2e8f0", cursor: "pointer", fontSize: 10, fontWeight: 600, fontFamily: "inherit", transition: "all 0.15s" }),
    btnDanger: { background: "rgba(239,68,68,0.15)", color: "#fca5a5", border: "1px solid rgba(239,68,68,0.3)" },
    iconBtn: { background: "none", border: "none", cursor: "pointer", padding: 3, fontSize: 13, opacity: 0.5, color: "inherit", lineHeight: 1 },
    input: { background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 4, padding: "4px 7px", color: "#e2e8f0", fontSize: 11, fontFamily: "inherit", width: "100%", outline: "none", boxSizing: "border-box" },
    dialog: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, backdropFilter: "blur(4px)" },
    dialogBox: { background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: 22, maxWidth: 400, width: "90%" },
    chip: { display: "inline-flex", alignItems: "center", background: "linear-gradient(135deg, #ea580c, #f97316)", color: "#fff", fontWeight: 700, fontSize: 11, padding: "5px 12px", borderRadius: 20 },
    attCard: (sel) => ({ display: "flex", alignItems: "center", gap: 7, padding: "7px 9px", borderRadius: 8, marginBottom: 5, cursor: "pointer", background: sel ? "rgba(59,130,246,0.15)" : "rgba(59,130,246,0.05)", border: sel ? "1px solid rgba(59,130,246,0.5)" : "1px solid rgba(59,130,246,0.15)", transition: "all 0.15s" }),
    section: { background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, padding: 10, marginBottom: 10 },
    sectionLabel: { fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 2, marginBottom: 6, textAlign: "center" },
  };

  return (
    <main
      id="calendar-task-app"
      className="calendar-task-app"
      aria-label="Calendar Task App"
      style={S.app}
    >
      <style>{`
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&display=swap');
        .calendar-task-app__sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }
        .calendar-task-app button {
          -webkit-tap-highlight-color: transparent;
        }
        textarea:focus, input:focus {
          outline: none;
          box-shadow: inset 0 0 0 1.5px rgba(249,115,22,0.85);
        }
        button:focus-visible {
          outline: none;
          box-shadow: inset 0 0 0 2px rgba(249,115,22,0.85);
        }
        button[data-panel-toggle]:focus-visible {
          box-shadow: none;
        }
        [data-focusable-card]:focus, [data-focusable-card]:focus-visible {
          outline: none;
          box-shadow: inset 0 0 0 2px rgba(249,115,22,0.85);
        }
        [data-nav-column]:focus { outline: none; }
        [data-nav-column][data-nav-active="true"] {
          box-shadow: inset 0 0 0 1.5px #c2410c;
          background: transparent;
        }
        .md-render h1 { font-size: 16px; font-weight: 800; margin: 12px 0 6px; color: #dc143c; }
        .md-render h2 { font-size: 14px; font-weight: 700; margin: 10px 0 4px; color: #dc143c; }
        .md-render h3 { font-size: 12px; font-weight: 700; margin: 8px 0 4px; color: #dc143c; }
        .md-render blockquote { border-left: 3px solid rgba(255,255,255,0.15); padding-left: 10px; margin: 6px 0; opacity: 0.6; }
        .md-render ul { padding-left: 18px; margin: 4px 0; }
        .md-render li { margin: 2px 0; }
        .md-render strong { color: #b8f3ff; }
        .md-render em { color: rgba(255,255,255,0.5); }
        .notes-mdx-shell { min-height: 140px; border: 1px solid rgba(255,255,255,0.12); border-radius: 4px; overflow: hidden; background: rgba(255,255,255,0.06); }
        .notes-mdx-shell .mdxeditor { --baseBase: #171923; --baseBgSubtle: #1b1c27; --baseBg: #20212d; --baseBgHover: #292a37; --baseBgActive: #30313f; --baseLine: #3d3f4c; --baseBorder: #4a4c59; --baseBorderHover: #5b5d6b; --baseText: #e2e8f0; --baseTextContrast: #ffffff; --basePageBg: #20212d; --accentText: #c084fc; min-height: 140px; background: transparent; color: #e2e8f0; font-family: inherit; font-size: 11px; }
        .notes-mdx-shell .mdxeditor-root-contenteditable, .notes-mdx-shell [contenteditable="true"] { color: #e2e8f0 !important; caret-color: #f97316; }
        .notes-mdx-shell [contenteditable="true"] { min-height: 140px; padding: 8px 10px; line-height: 1.6; color: #e2e8f0; }
        .notes-mdx-shell [contenteditable="true"] p { margin: 0 0 8px; }
        .notes-mdx-shell [contenteditable="true"] h1 { font-size: 16px; color: #dc143c !important; }
        .notes-mdx-shell [contenteditable="true"] h2 { font-size: 14px; color: #dc143c !important; }
        .notes-mdx-shell [contenteditable="true"] h3 { font-size: 12px; color: #dc143c !important; }
        .notes-mdx-shell [contenteditable="true"] strong { color: #b8f3ff !important; }
        .notes-mdx-shell [contenteditable="true"] em { color: rgba(255,255,255,0.5); }
        .notes-mdx-shell [contenteditable="true"] code {
          color: #fb923c !important;
          font-family: "JetBrains Mono", monospace;
        }
        .notes-mdx-shell [contenteditable="true"] p code,
        .notes-mdx-shell [contenteditable="true"] li code,
        .notes-mdx-shell [contenteditable="true"] blockquote code {
          padding: 1px 4px;
          border-radius: 3px;
          background: rgba(249,115,22,0.14);
        }
        .notes-mdx-shell pre {
          margin: 8px 0;
          padding: 8px 10px;
          overflow-x: auto;
          border: 1px solid rgba(249,115,22,0.4);
          border-radius: 4px;
          background: rgba(249,115,22,0.1);
          color: #fb923c !important;
          font-family: "JetBrains Mono", monospace;
        }
        .notes-mdx-shell pre code {
          padding: 0;
          background: transparent;
          color: #fb923c !important;
        }
        .notes-mdx-shell .cm-editor {
          margin: 8px 0;
          border: 1px solid rgba(249,115,22,0.4);
          border-radius: 4px;
          background: rgba(249,115,22,0.1);
          color: #fb923c !important;
        }
        .notes-mdx-shell .cm-scroller {
          overflow: auto;
          font-family: "JetBrains Mono", monospace;
        }
        .notes-mdx-shell .cm-content,
        .notes-mdx-shell .cm-line,
        .notes-mdx-shell .cm-content span {
          color: #fb923c !important;
        }
      `}</style>

      {/* ═══ COL 1: TASKS ═══ */}
      <section
        data-nav-column="tasks"
        data-nav-active={navColumn === "tasks" ? "true" : "false"}
        id="tasks-panel"
        className="calendar-task-app__panel calendar-task-app__panel--tasks"
        role="region"
        aria-labelledby="tasks-panel-title"
        tabIndex={-1}
        style={{ ...S.col, flex: isMobile ? "0 0 auto" : panelOpen.tasks ? "22 1 0" : "0 0 11%", transition: "flex 0.2s ease" }}
        onFocusCapture={() => setNavColumn("tasks")}
      >
        <button
          id="tasks-panel-toggle"
          className="calendar-task-app__panel-toggle"
          type="button"
          data-panel-toggle
          title={panelOpen.tasks ? "Collapse Tasks panel" : "Expand Tasks panel"}
          aria-expanded={panelOpen.tasks}
          aria-controls={panelOpen.tasks ? "tasks-panel-content" : undefined}
          aria-label={`${panelOpen.tasks ? "Collapse" : "Expand"} Tasks panel`}
          onClick={() => togglePanel("tasks")}
          style={{ ...S.iconBtn, ...S.colTitle, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 5, opacity: 1, padding: "0 0 10px", color: "rgba(255,255,255,0.3)" }}
        >
          <span aria-hidden="true" style={{ transform: panelOpen.tasks ? "rotate(180deg)" : "none", transition: "transform 0.15s", fontSize: 10 }}>{"\u25BC"}</span>
          <span id="tasks-panel-title" className="calendar-task-app__panel-title">Tasks ({tasks.length})</span>
        </button>
        {panelOpen.tasks && (
          <>
        <div
          id="tasks-panel-content"
          className="calendar-task-app__panel-content calendar-task-app__task-list"
          style={S.colScroll}
          role="listbox"
          aria-label="Tasks"
          aria-orientation="vertical"
          aria-activedescendant={tasks[focusedTaskIdx] ? `task-card-${tasks[focusedTaskIdx].id}` : undefined}
        >
          {tasks.map((task, idx) => {
            const sel = task.id === selectedTaskId;
            const notesOpen = !!expandedNotes[task.id];
            const listFocused = focusedTaskIdx === idx;
            return (
              <div key={task.id} className="calendar-task-app__task-item" style={{ marginBottom: 6 }}>
                <div
                  ref={(el) => { taskCardRefs.current[idx] = el; }}
                  id={`task-card-${task.id}`}
                  className={`calendar-task-app__task-card${sel ? " calendar-task-app__task-card--selected" : ""}`}
                  data-focusable-card
                  role="option"
                  aria-selected={sel}
                  tabIndex={listFocused ? 0 : -1}
                  aria-label={`Task T${task.id}${task.description ? `: ${task.description}` : ""}`}
                  draggable
                  onDragStart={() => onDragStart(idx)}
                  onDragOver={onDragOver}
                  onDrop={(e) => onDrop(e, idx)}
                  style={{ ...S.taskCard(sel), marginBottom: 0, borderBottomLeftRadius: notesOpen ? 0 : 8, borderBottomRightRadius: notesOpen ? 0 : 8 }}
                  onClick={() => {
                    setSelectedTaskId(task.id);
                    setFocusedTaskIdx(idx);
                    setNavColumn("tasks");
                  }}
                  onFocus={() => {
                    setFocusedTaskIdx(idx);
                    setNavColumn("tasks");
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedTaskId(task.id);
                    }
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div className="calendar-task-app__task-badge" style={S.badge}>T<sub>{task.id}</sub></div>
                    <div className="calendar-task-app__task-actions" style={{ display: "flex", gap: 2 }}>
                      <button
                        id={`complete-task-${task.id}`}
                        className="calendar-task-app__icon-button calendar-task-app__task-complete"
                        type="button"
                        tabIndex={listFocused ? 0 : -1}
                        style={S.iconBtn}
                        title="Complete task"
                        aria-label={`Complete task T${task.id}`}
                        onClick={(e) => { e.stopPropagation(); setCompleteDialog(task); }}
                      >
                        {"\u2713"}
                      </button>
                      <button
                        id={`delete-task-${task.id}`}
                        className="calendar-task-app__icon-button calendar-task-app__task-delete"
                        type="button"
                        tabIndex={listFocused ? 0 : -1}
                        style={{ ...S.iconBtn, color: sel ? "#fca5a5" : "#f87171" }}
                        title="Delete task"
                        aria-label={`Delete task T${task.id}`}
                        onClick={(e) => { e.stopPropagation(); setDeleteDialog(task); }}
                      >
                        {"\u2715"}
                      </button>
                    </div>
                  </div>
                  {editingDesc === task.id ? (
                    <input
                      id={`task-description-${task.id}`}
                      className="calendar-task-app__task-description-input"
                      autoFocus
                      aria-label={`Description for task T${task.id}`}
                      style={S.input}
                      defaultValue={task.description}
                      placeholder="Task description..."
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => { setTasks((prev) => prev.map((t) => t.id === task.id ? { ...t, description: e.target.value } : t)); setEditingDesc(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEditingDesc(null); }} />
                  ) : (
                    <div
                      className="calendar-task-app__task-description"
                      style={S.desc}
                      onDoubleClick={(e) => { e.stopPropagation(); setEditingDesc(task.id); }}
                    >
                      {task.description || <span style={{ opacity: 0.4, fontStyle: "italic" }}>Double-click to edit...</span>}
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: 3 }}>
                    <div className="calendar-task-app__task-time" style={{ ...S.time, fontSize: 14 }}>{fmtTime(task.timeOnTask)}</div>
                    <button
                      id={`toggle-task-notes-${task.id}`}
                      className="calendar-task-app__icon-button calendar-task-app__task-notes-toggle"
                      type="button"
                      tabIndex={listFocused ? 0 : -1}
                      title={notesOpen ? "Collapse notepad" : "Expand notepad"}
                      aria-expanded={notesOpen}
                      aria-controls={`task-notes-${task.id}`}
                      aria-label={`${notesOpen ? "Collapse" : "Expand"} notes for task T${task.id}`}
                      onClick={(e) => toggleTaskNotes(task.id, e)}
                      style={{
                        ...S.iconBtn,
                        opacity: 0.85,
                        color: sel ? "#86efac" : "#4ade80",
                        fontSize: 10,
                        padding: "2px 4px",
                        transform: notesOpen ? "rotate(180deg)" : "none",
                        transition: "transform 0.15s",
                      }}
                    >
                      {"\u25BC"}
                    </button>
                  </div>
                </div>
                {notesOpen && (
                  <div
                    id={`task-notes-${task.id}`}
                    className="calendar-task-app__task-notes"
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      background: "rgba(134,239,172,0.18)",
                      border: sel ? "1px solid #22c55e" : "1px solid rgba(34,197,94,0.35)",
                      borderTop: "none",
                      borderBottomLeftRadius: 8,
                      borderBottomRightRadius: 8,
                      padding: 8,
                      minHeight: 88,
                    }}
                  >
                    <textarea
                      id={`task-notes-input-${task.id}`}
                      className="calendar-task-app__task-notes-input"
                      value={task.notes || ""}
                      aria-label={`Notes for task T${task.id}`}
                      placeholder="Task notes..."
                      onChange={(e) => updateTaskNotes(task.id, e.target.value)}
                      style={{
                        ...S.input,
                        minHeight: 72,
                        resize: "vertical",
                        background: "transparent",
                        border: "none",
                        color: "#dcfce7",
                        fontSize: 11,
                        lineHeight: 1.45,
                        padding: 2,
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <button
          id="add-task"
          className="calendar-task-app__button calendar-task-app__add-task"
          type="button"
          style={{ ...S.btn("rgba(34,197,94,0.15)"), border: "1px dashed rgba(34,197,94,0.4)", marginTop: 6, width: "100%" }}
          onClick={addTask}
        >
          + Add Task
        </button>
          </>
        )}
      </section>

      {/* ═══ COL 2: WIDGETS ═══ */}
      <section
        ref={widgetsColRef}
        data-nav-column="widgets"
        data-nav-active={navColumn === "widgets" ? "true" : "false"}
        id="widgets-panel"
        className="calendar-task-app__panel calendar-task-app__panel--widgets"
        role="region"
        aria-labelledby="widgets-panel-title"
        tabIndex={-1}
        style={{ ...S.col, flex: isMobile ? "0 0 auto" : panelOpen.widgets ? "30 1 0" : "0 0 15%", transition: "flex 0.2s ease" }}
        onFocusCapture={() => setNavColumn("widgets")}
      >
        <button
          id="widgets-panel-toggle"
          className="calendar-task-app__panel-toggle"
          type="button"
          data-panel-toggle
          title={panelOpen.widgets ? "Collapse Widgets panel" : "Expand Widgets panel"}
          aria-expanded={panelOpen.widgets}
          aria-controls={panelOpen.widgets ? "widgets-panel-content" : undefined}
          aria-label={`${panelOpen.widgets ? "Collapse" : "Expand"} Widgets panel`}
          onClick={() => togglePanel("widgets")}
          style={{ ...S.iconBtn, ...S.colTitle, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 5, opacity: 1, padding: "0 0 10px", color: "rgba(255,255,255,0.3)" }}
        >
          <span aria-hidden="true" style={{ transform: panelOpen.widgets ? "rotate(180deg)" : "none", transition: "transform 0.15s", fontSize: 10 }}>{"\u25BC"}</span>
          <span id="widgets-panel-title" className="calendar-task-app__panel-title">Widgets</span>
        </button>
        {panelOpen.widgets && (
          <div id="widgets-panel-content" className="calendar-task-app__panel-content calendar-task-app__widgets" style={S.colScroll}>

          {/* --- TOP ROW: Today + Date + Play/Pause --- */}
          <div className="calendar-task-app__widget-toolbar" style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <button
              id="go-today"
              className="calendar-task-app__button calendar-task-app__go-today"
              type="button"
              onClick={goToday}
              aria-label={isToday ? "Today, current date selected" : "Go to today"}
              style={{
                ...S.btn(isToday ? "rgba(34,197,94,0.2)" : "rgba(249,115,22,0.2)"),
                border: `1px solid ${isToday ? "rgba(34,197,94,0.5)" : "rgba(249,115,22,0.5)"}`,
                color: isToday ? "#86efac" : "#fb923c",
                padding: "5px 10px", fontSize: 10, fontWeight: 700, flexShrink: 0,
              }}
            >
              {isToday ? "\u2713 today" : "today"}
            </button>
            <span id="selected-date-display" className="calendar-task-app__selected-date" style={{ ...S.chip, flex: 1, justifyContent: "center", fontSize: 11 }}>
              {fmtDateDisplay(selectedDate)}
            </span>
            <PlayPauseButton
              id="task-timer-toggle"
              className="calendar-task-app__task-timer-toggle"
              running={timerRunning}
              onToggle={toggleTimer}
              ariaLabel={timerRunning ? "Pause task timer" : "Start task timer"}
            />
          </div>

          {/* --- SYNC --- */}
          <button
            id="sync-storage"
            className="calendar-task-app__button calendar-task-app__sync"
            type="button"
            onClick={handleSyncClick}
            title="Triple-click for sound demo"
            aria-label={dirty ? "Save changes now" : "Saved. Triple-click for sound demo"}
            aria-live="polite"
            style={{
              ...S.btn(dirty ? "rgba(249,115,22,0.15)" : "rgba(34,197,94,0.1)"),
              border: `1px solid ${dirty ? "rgba(249,115,22,0.4)" : soundDemoOpen ? "rgba(255,255,255,0.35)" : "rgba(34,197,94,0.3)"}`,
              color: dirty ? "#fb923c" : "#86efac",
              width: "100%", padding: "5px 10px", fontSize: 9, marginBottom: 8,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            }}
          >
            <span style={{ fontSize: 11 }}>{dirty ? "\u25CF" : "\u2713"}</span>
            {dirty ? "SYNC" : "SYNCED"}
            {lastSynced && <span style={{ opacity: 0.4, marginLeft: 4 }}>{lastSynced.toLocaleTimeString()}</span>}
          </button>

          {soundDemoOpen && (
            <section
              id="sound-demo"
              className="calendar-task-app__widget-section calendar-task-app__sound-demo"
              aria-labelledby="sound-demo-title"
              style={{
              ...S.section,
              borderColor: "rgba(255,255,255,0.12)",
              marginBottom: 8,
              padding: "8px 10px",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}>
              <div className="calendar-task-app__section-heading" style={{ ...S.sectionLabel, marginBottom: 0, color: "rgba(255,255,255,0.35)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span id="sound-demo-title">Sound demo</span>
                <button
                  id="close-sound-demo"
                  className="calendar-task-app__icon-button"
                  type="button"
                  onClick={() => setSoundDemoOpen(false)}
                  style={{ ...S.iconBtn, fontSize: 10, padding: "0 4px", color: "rgba(255,255,255,0.35)" }}
                  title="Hide sound demo"
                  aria-label="Hide sound demo"
                >
                  {"\u2715"}
                </button>
              </div>
              <div className="calendar-task-app__sound-demo-actions" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button id="sound-demo-task-timer" className="calendar-task-app__button" type="button" onClick={() => audio.timerComplete()} style={{ ...S.btn("rgba(249,115,22,0.15)"), border: "1px solid rgba(249,115,22,0.4)", color: "#fb923c", fontSize: 9, padding: "4px 8px" }}>
                  300s · 3
                </button>
                <button id="sound-demo-focus" className="calendar-task-app__button" type="button" onClick={() => audio.pomodoroComplete()} style={{ ...S.btn("rgba(220,38,38,0.15)"), border: "1px solid rgba(220,38,38,0.4)", color: "#fca5a5", fontSize: 9, padding: "4px 8px" }}>
                  Focus · 5
                </button>
                <button id="sound-demo-break" className="calendar-task-app__button" type="button" onClick={() => audio.breakComplete()} style={{ ...S.btn("rgba(37,99,235,0.15)"), border: "1px solid rgba(37,99,235,0.4)", color: "#93c5fd", fontSize: 9, padding: "4px 8px" }}>
                  Break · 2
                </button>
              </div>
            </section>
          )}

          {/* --- Calendar --- */}
          <section
            id="calendar-widget"
            className="calendar-task-app__widget-section calendar-task-app__calendar"
            role="region"
            aria-labelledby="calendar-widget-title"
            style={S.section}
          >
            <div className="calendar-task-app__calendar-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <button
                id="calendar-previous-month"
                className="calendar-task-app__icon-button"
                type="button"
                style={S.iconBtn}
                onClick={prevMonth}
                aria-label="Previous month"
              >
                {"\u25C2"}
              </button>
              <h2 id="calendar-widget-title" className="calendar-task-app__section-title" style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.5)" }}>
                {new Date(calYear, calMonth).toLocaleString("en-US", { month: "long", year: "numeric" })}
              </h2>
              <button
                id="calendar-next-month"
                className="calendar-task-app__icon-button"
                type="button"
                style={S.iconBtn}
                onClick={nextMonth}
                aria-label="Next month"
              >
                {"\u25B8"}
              </button>
            </div>
            <div
              id="calendar-grid"
              className="calendar-task-app__calendar-grid"
              role="group"
              aria-labelledby="calendar-widget-title"
              style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, textAlign: "center" }}
            >
              {["M", "T", "W", "R", "F", "S", "S"].map((d, i) => (
                <span
                  key={i}
                  className="calendar-task-app__calendar-weekday"
                  aria-hidden="true"
                  style={{ fontSize: 8, fontWeight: 700, color: "rgba(255,255,255,0.2)", padding: "2px 0" }}
                >
                  {d}
                </span>
              ))}
              {calDays.map((day, i) => (
                day ? (
                  <button
                    key={i}
                    id={`calendar-day-${calendarDayIso(day)}`}
                    className={`calendar-task-app__calendar-day${isDaySelected(day) ? " calendar-task-app__calendar-day--selected" : ""}`}
                    type="button"
                    aria-label={calendarDayLabel(day)}
                    aria-pressed={isDaySelected(day)}
                    aria-current={calendarDayIso(day) === todayStr() ? "date" : undefined}
                    onClick={() => selectDay(day)}
                    style={{
                      padding: "4px 0", borderRadius: 6, fontSize: 10, fontWeight: 600,
                      cursor: "pointer", border: "none", fontFamily: "inherit",
                      background: isDaySelected(day) ? "#f97316" : isSelectedWeek(day) ? "rgba(249,115,22,0.1)" : isCurrentWeek(day) ? "rgba(147,197,253,0.08)" : "transparent",
                      color: isDaySelected(day) ? "#fff" : "rgba(255,255,255,0.55)",
                      transition: "all 0.15s",
                    }}
                  >
                    {day}
                  </button>
                ) : (
                  <span key={i} className="calendar-task-app__calendar-day calendar-task-app__calendar-day--empty" aria-hidden="true" />
                )
              ))}
            </div>
            <div className="calendar-task-app__calendar-date-picker" style={{ display: "flex", gap: 6, marginTop: 6, justifyContent: "center" }}>
              <label className="calendar-task-app__sr-only" htmlFor="calendar-date-input">Select date</label>
              <input
                id="calendar-date-input"
                className="calendar-task-app__date-input"
                type="date"
                value={selectedDate}
                aria-label="Select calendar date"
                onChange={(e) => { selectDate(e.target.value); const d = new Date(e.target.value + "T12:00:00"); setCalMonth(d.getMonth()); setCalYear(d.getFullYear()); }}
                style={{ ...S.input, width: "auto", fontSize: 9, padding: "2px 6px" }}
              />
            </div>
          </section>

          {/* --- 300s Timer Grid --- */}
          <section
            id="task-timer"
            className="calendar-task-app__widget-section calendar-task-app__timer"
            role="region"
            aria-labelledby="task-timer-title"
            style={{ ...S.section, borderColor: "rgba(249,115,22,0.12)" }}
          >
            <h2 id="task-timer-title" className="calendar-task-app__section-title" style={{ ...S.sectionLabel, color: "rgba(249,115,22,0.5)" }}>300s Timer {"\u2014"} {timerSeconds}/300</h2>
            <div
              id="task-timer-progress"
              className="calendar-task-app__timer-progress"
              role="progressbar"
              aria-label="Task timer progress"
              aria-valuemin={0}
              aria-valuemax={300}
              aria-valuenow={timerSeconds}
              aria-valuetext={`${timerSeconds} of 300 seconds`}
              style={{ display: "grid", gridTemplateColumns: "repeat(30, 1fr)", gap: 1.5 }}
            >
              {circles.map((filled, i) => (
                <span
                  key={i}
                  className="calendar-task-app__timer-dot"
                  aria-hidden="true"
                  style={{ width: "100%", paddingTop: "100%", borderRadius: "50%", background: filled ? "#f97316" : "rgba(255,255,255,0.04)", border: "1px solid " + (filled ? "#fb923c" : "rgba(255,255,255,0.06)"), transition: "background 0.2s" }}
                />
              ))}
            </div>
          </section>

          {/* --- Pomodoro --- */}
          <section
            id="pomodoro-widget"
            className="calendar-task-app__widget-section calendar-task-app__pomodoro"
            role="region"
            aria-labelledby="pomodoro-title"
            style={{
            ...S.section,
            borderColor: pomodoroRunning ? "rgba(220,38,38,0.45)" : "rgba(255,255,255,0.08)",
            transition: "border-color 0.2s",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, gap: 6 }}>
              <h2
                id="pomodoro-title"
                className="calendar-task-app__section-title"
                style={{
                ...S.sectionLabel,
                color: pomodoroRunning ? "#dc2626" : "rgba(255,255,255,0.28)",
                marginBottom: 0,
                flex: 1,
                transition: "color 0.2s",
              }}>
                {pomodoroRunning ? "\uD83C\uDF45" : "\uD83E\uDD6B"}{" "}
                {pomodoroLabel}
              </h2>
              <PlayPauseButton
                id="pomodoro-toggle"
                className="calendar-task-app__pomodoro-toggle"
                running={pomodoroRunning}
                onToggle={togglePomodoro}
                ariaLabel={pomodoroRunning ? `Pause Pomodoro ${pomodoroLabel.toLowerCase()} timer` : `Start Pomodoro ${pomodoroLabel.toLowerCase()} timer`}
                style={pomodoroRunning
                  ? { padding: "3px 10px", fontSize: 13 }
                  : {
                      padding: "3px 10px",
                      fontSize: 13,
                      background: "rgba(255,255,255,0.06)",
                      border: "1px solid rgba(255,255,255,0.18)",
                      color: "rgba(255,255,255,0.4)",
                    }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, opacity: pomodoroRunning || pomodoroPhase === "breakPending" ? 1 : 0.45, transition: "opacity 0.2s" }}>
              <button
                id="focus-sound-toggle"
                className="calendar-task-app__sound-toggle calendar-task-app__sound-toggle--focus"
                type="button"
                title={focusSoundEnabled ? "Focus stop sound on — click to disable" : "Focus stop sound off — click to enable"}
                aria-label={focusSoundEnabled ? "Disable focus completion sound" : "Enable focus completion sound"}
                aria-pressed={focusSoundEnabled}
                onClick={() => setFocusSoundEnabled((v) => !v)}
                style={{
                  background: focusSoundEnabled ? "rgba(220,38,38,0.2)" : "rgba(255,255,255,0.04)",
                  border: `1px solid ${focusSoundEnabled ? "rgba(220,38,38,0.45)" : "rgba(255,255,255,0.12)"}`,
                  borderRadius: 4,
                  padding: "1px 5px",
                  fontSize: 8,
                  fontWeight: 600,
                  color: focusSoundEnabled ? "#fca5a5" : "rgba(255,255,255,0.25)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  lineHeight: 1.3,
                  flexShrink: 0,
                  minWidth: 26,
                }}
              >
                {focusSoundEnabled ? "on" : "off"}
              </button>
              <span style={{ fontSize: 9, width: 34, color: pomodoroRunning ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.25)" }}>Focus</span>
              <div
                id="focus-progress"
                className="calendar-task-app__pomodoro-progress calendar-task-app__pomodoro-progress--focus"
                role="progressbar"
                aria-label="Focus progress"
                aria-valuemin={0}
                aria-valuemax={1500}
                aria-valuenow={pomodoroPhase === "work" ? pomodoroSeconds : pomodoroPhase === "breakPending" ? 1500 : 0}
                aria-valuetext={pomodoroPhase === "work" ? `${fmtTime(pomodoroSeconds)} elapsed` : pomodoroPhase === "breakPending" ? "Focus complete" : "Not active"}
                style={{ flex: 1, height: 7, background: "rgba(255,255,255,0.04)", borderRadius: 4, overflow: "hidden" }}
              >
                <div style={{ width: (pomodoroPhase === "work" ? (pomodoroSeconds / 1500) * 100 : pomodoroPhase === "breakPending" ? 100 : 0) + "%", height: "100%", background: pomodoroRunning ? "linear-gradient(90deg, #dc2626, #f97316)" : "rgba(255,255,255,0.2)", borderRadius: 4, transition: "width 0.5s, background 0.2s" }} />
              </div>
              <span style={{ fontSize: 9, width: 44, textAlign: "right", fontVariantNumeric: "tabular-nums", color: pomodoroRunning ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.25)" }}>
                {pomodoroPhase === "work" ? fmtTime(pomodoroSeconds) : pomodoroPhase === "breakPending" ? "25:00" : "\u2014"}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, opacity: pomodoroRunning && pomodoroPhase === "break" ? 1 : 0.45, transition: "opacity 0.2s" }}>
              <button
                id="break-sound-toggle"
                className="calendar-task-app__sound-toggle calendar-task-app__sound-toggle--break"
                type="button"
                title={breakSoundEnabled ? "Break sound on — click to disable" : "Break sound off — click to enable"}
                aria-label={breakSoundEnabled ? "Disable break completion sound" : "Enable break completion sound"}
                aria-pressed={breakSoundEnabled}
                onClick={() => setBreakSoundEnabled((v) => !v)}
                style={{
                  background: breakSoundEnabled ? "rgba(37,99,235,0.2)" : "rgba(255,255,255,0.04)",
                  border: `1px solid ${breakSoundEnabled ? "rgba(37,99,235,0.45)" : "rgba(255,255,255,0.12)"}`,
                  borderRadius: 4,
                  padding: "1px 5px",
                  fontSize: 8,
                  fontWeight: 600,
                  color: breakSoundEnabled ? "#93c5fd" : "rgba(255,255,255,0.25)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  lineHeight: 1.3,
                  flexShrink: 0,
                  minWidth: 26,
                }}
              >
                {breakSoundEnabled ? "on" : "off"}
              </button>
              <span style={{ fontSize: 9, width: 34, color: "rgba(255,255,255,0.35)" }}>Break</span>
              <div
                id="break-progress"
                className="calendar-task-app__pomodoro-progress calendar-task-app__pomodoro-progress--break"
                role="progressbar"
                aria-label="Break progress"
                aria-valuemin={0}
                aria-valuemax={300}
                aria-valuenow={pomodoroPhase === "break" ? pomodoroSeconds : 0}
                aria-valuetext={pomodoroPhase === "break" ? `${fmtTime(pomodoroSeconds)} elapsed` : "Not active"}
                style={{ flex: 1, height: 7, background: "rgba(255,255,255,0.04)", borderRadius: 4, overflow: "hidden" }}
              >
                <div style={{ width: (pomodoroPhase === "break" ? (pomodoroSeconds / 300) * 100 : 0) + "%", height: "100%", background: pomodoroRunning ? "linear-gradient(90deg, #2563eb, #7c3aed)" : "rgba(255,255,255,0.2)", borderRadius: 4, transition: "width 0.5s, background 0.2s" }} />
              </div>
              <span style={{ fontSize: 9, width: 44, textAlign: "right", fontVariantNumeric: "tabular-nums", color: "rgba(255,255,255,0.35)" }}>
                {pomodoroPhase === "break" ? fmtTime(pomodoroSeconds) : "\u2014"}
              </span>
            </div>
            <div className="calendar-task-app__pomodoro-count" aria-live="polite" style={{ textAlign: "center", marginTop: 6, fontSize: 10, color: "rgba(255,255,255,0.25)" }}>
              Completed: <strong style={{ color: pomodoroRunning ? "#f97316" : "rgba(255,255,255,0.35)" }}>{pomodoroCount}</strong> pomodoros
            </div>
          </section>
          </div>
        )}
      </section>

      {/* ═══ COL 3: ATTACHMENTS + NOTES ═══ */}
      <section
        data-nav-column="attachments"
        data-nav-active={navColumn === "attachments" ? "true" : "false"}
        id="attachments-panel"
        className="calendar-task-app__panel calendar-task-app__panel--attachments"
        role="region"
        aria-labelledby="attachments-panel-title"
        tabIndex={-1}
        style={{ ...S.col, flex: isMobile ? "0 0 auto" : panelOpen.attachments ? "24 1 0" : "0 0 12%", transition: "flex 0.2s ease" }}
        onFocusCapture={() => setNavColumn("attachments")}
      >
        <button
          id="attachments-panel-toggle"
          className="calendar-task-app__panel-toggle"
          type="button"
          data-panel-toggle
          ref={attachmentsPanelToggleRef}
          title={panelOpen.attachments ? "Collapse Attachments & Notes panel" : "Expand Attachments & Notes panel"}
          aria-expanded={panelOpen.attachments}
          aria-controls={panelOpen.attachments ? "attachments-panel-content" : undefined}
          aria-label={`${panelOpen.attachments ? "Collapse" : "Expand"} Attachments and Notes panel`}
          onClick={() => togglePanel("attachments")}
          style={{ ...S.iconBtn, ...S.colTitle, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 5, opacity: 1, padding: "0 0 10px", color: "rgba(255,255,255,0.3)" }}
        >
          <span aria-hidden="true" style={{ transform: panelOpen.attachments ? "rotate(180deg)" : "none", transition: "transform 0.15s", fontSize: 10 }}>{"\u25BC"}</span>
          <span id="attachments-panel-title" className="calendar-task-app__panel-title">Attachments &amp; Notes</span>
        </button>
        {panelOpen.attachments && (
          <>
        <div id="attachments-panel-content" className="calendar-task-app__panel-content calendar-task-app__attachments" style={S.colScroll}>
          <div className="calendar-task-app__week-summary" aria-live="polite" style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", textAlign: "center", marginBottom: 8 }}>{currentWeekKey} {"\u2014"} {currentWeekRange}</div>

          {/* Camera/upload */}
          <button
            id="attachment-upload"
            className="calendar-task-app__upload-zone"
            type="button"
            aria-label={isMobile ? "Choose camera or gallery for image attachment" : "Add PNG or JPEG image attachment"}
            onClick={openAttachmentPicker}
            style={{ border: "2px dashed rgba(59,130,246,0.25)", borderRadius: 10, padding: 12, textAlign: "center", cursor: "pointer", marginBottom: 8, width: "100%", color: "inherit", background: "transparent", fontFamily: "inherit" }}
          >
            <span aria-hidden="true" style={{ display: "block", fontSize: 20, marginBottom: 1 }}>{"\uD83D\uDCF7"}</span>
            <span style={{ display: "block", fontSize: 8, color: "rgba(255,255,255,0.3)" }}>{isMobile ? "Choose camera or gallery" : "Click to add image"}</span>
          </button>
          <input
            ref={fileRef}
            id="attachment-gallery-input"
            className="calendar-task-app__file-input"
            type="file"
            accept="image/png,image/jpeg"
            aria-label="Choose PNG or JPEG image from gallery"
            hidden
            onChange={handleFileSelect}
          />
          <input
            ref={cameraFileRef}
            id="attachment-camera-input"
            className="calendar-task-app__file-input"
            type="file"
            accept="image/png,image/jpeg"
            capture="environment"
            aria-label="Take a PNG or JPEG photo with camera"
            hidden
            onChange={handleFileSelect}
          />
          {attachmentSourceOpen && (
            <AttachmentSourceDialog
              onCamera={() => chooseAttachmentSource("camera")}
              onGallery={() => chooseAttachmentSource("gallery")}
              onCancel={() => setAttachmentSourceOpen(false)}
            />
          )}

          {/* Attachment list */}
          <div id="attachment-list" className="calendar-task-app__attachment-list" role="listbox" aria-label="Attachments" aria-orientation="vertical" aria-activedescendant={attachments[focusedAttIdx] ? `attachment-card-${attachments[focusedAttIdx].id}` : undefined}>
          {attachments.map((att, idx) => {
            const listFocused = focusedAttIdx === idx;
            return (
            <div
              key={att.id}
              ref={(el) => { attCardRefs.current[idx] = el; }}
              id={`attachment-card-${att.id}`}
              className={`calendar-task-app__attachment-card${att.id === selectedAttId ? " calendar-task-app__attachment-card--selected" : ""}`}
              data-focusable-card
              role="option"
              aria-selected={att.id === selectedAttId}
              tabIndex={listFocused ? 0 : -1}
              aria-label={`Attachment: ${att.name}`}
              style={S.attCard(att.id === selectedAttId)}
              onClick={() => {
                setSelectedAttId(att.id);
                setFocusedAttIdx(idx);
                setNavColumn("attachments");
              }}
              onFocus={() => {
                setFocusedAttIdx(idx);
                setNavColumn("attachments");
              }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelectedAttId(att.id);
                }
              }}
            >
              <button
                id={`zoom-attachment-${att.id}`}
                className="calendar-task-app__attachment-preview-button"
                type="button"
                aria-label={`Open image preview for ${att.name}`}
                onClick={(e) => { e.stopPropagation(); openZoom(att); }}
                style={{ border: "none", padding: 0, background: "transparent", display: "flex", flexShrink: 0, cursor: "zoom-in" }}
              >
                <img
                  src={att.dataUri}
                  alt=""
                  style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 4, flexShrink: 0 }}
                />
              </button>
              <div className="calendar-task-app__attachment-name" style={{ flex: 1, minWidth: 0 }}>
                {editingAttName === att.id ? (
                  <input
                    id={`attachment-name-${att.id}`}
                    className="calendar-task-app__attachment-name-input"
                    autoFocus
                    aria-label={`Filename for ${att.name}`}
                    style={{ ...S.input, fontSize: 9 }}
                    defaultValue={att.name}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => { setAttachments((prev) => prev.map((a) => a.id === att.id ? { ...a, name: e.target.value } : a)); setEditingAttName(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }} />
                ) : (
                  <div style={{ fontSize: 9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} onDoubleClick={(e) => { e.stopPropagation(); setEditingAttName(att.id); }} title={att.name}>{att.name}</div>
                )}
              </div>
              <button
                id={`delete-attachment-${att.id}`}
                className="calendar-task-app__icon-button calendar-task-app__attachment-delete"
                type="button"
                tabIndex={listFocused ? 0 : -1}
                style={{ ...S.iconBtn, color: "#f87171", fontSize: 11 }}
                title="Delete attachment"
                aria-label={`Delete attachment ${att.name}`}
                onClick={(e) => { e.stopPropagation(); setDeleteAttDialog(att); }}
              >
                {"\u2715"}
              </button>
            </div>
            );
          })}
          </div>

          {/* Small inline preview */}
          {selectedAtt && (
            <button
              id="selected-attachment-preview"
              className="calendar-task-app__selected-attachment-preview"
              type="button"
              aria-label={`Open image preview for ${selectedAtt.name}`}
              style={{ border: "2px dashed rgba(59,130,246,0.3)", borderRadius: 10, padding: 6, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 6, marginBottom: 8, cursor: "zoom-in" }}
              onClick={() => openZoom(selectedAtt)}
            >
              <img src={selectedAtt.dataUri} alt="" style={{ maxWidth: "100%", maxHeight: 140, objectFit: "contain", borderRadius: 6 }} />
            </button>
          )}

          {/* --- WEEKLY NOTES --- */}
          <section
            id="weekly-notes"
            className="calendar-task-app__widget-section calendar-task-app__notes"
            role="region"
            aria-labelledby="weekly-notes-title"
            style={{ ...S.section, borderColor: "rgba(168,85,247,0.15)", marginTop: 6 }}
          >
            <button
              id="weekly-notes-toggle"
              className="calendar-task-app__section-toggle"
              type="button"
              title={notesEditorOpen ? "Collapse notes editor" : "Expand notes editor"}
              aria-expanded={notesEditorOpen}
              aria-controls={notesEditorOpen ? "weekly-notes-editor" : undefined}
              aria-label={`${notesEditorOpen ? "Collapse" : "Expand"} weekly notes editor`}
              onClick={() => setNotesEditorOpen((open) => !open)}
              style={{ ...S.iconBtn, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 5, color: "rgba(168,85,247,0.6)", opacity: 1, padding: "0 0 6px" }}
            >
              <span aria-hidden="true" style={{ transform: notesEditorOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s", fontSize: 10 }}>{"\u25BC"}</span>
              <span id="weekly-notes-title" style={{ ...S.sectionLabel, color: "inherit", marginBottom: 0 }}>Notes {"\u2014"} {currentWeekKey}</span>
            </button>
            {notesEditorOpen && (
              <div id="weekly-notes-editor" className="notes-mdx-shell calendar-task-app__markdown-editor" onKeyDownCapture={handleNotesEditorKeyDown}>
                <MDXEditor
                  // Change the editor instance when the shortcut configuration
                  // changes; MDXEditor keeps its Lexical realm for the life of
                  // the instance, so a stale shortcut plugin must not survive
                  // a hot update or notes-panel remount.
                  key={`literal-hyphens-v2:${currentWeekKey}:${notesEditorVersion}`}
                  className="calendar-task-app__markdown-editor-input"
                  contentEditableClassName="calendar-task-app__markdown-editor-content"
                  markdown={noteContent}
                  onChange={handleNoteChange}
                  placeholder={"Notes for " + currentWeekRange + "..."}
                  translation={(key, defaultValue) => key === "contentArea.editableMarkdown" ? `Weekly notes for ${currentWeekRange}` : defaultValue}
                  plugins={[
                    headingsPlugin(),
                    listsPlugin(),
                    quotePlugin(),
                    codeBlockPlugin({
                      codeBlockEditorDescriptors: [exitOnEnterCodeBlockDescriptor],
                    }),
                    codeMirrorPlugin({
                      codeBlockLanguages: {
                        "": "Text",
                        js: "JavaScript",
                        ts: "TypeScript",
                        tsx: "TypeScript (React)",
                        jsx: "JavaScript (React)",
                        css: "CSS",
                      },
                    }),
                  ]}
                />
              </div>
            )}
            <div className="calendar-task-app__notes-actions" style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button
                id="export-markdown"
                className="calendar-task-app__button calendar-task-app__export"
                data-notes-export
                type="button"
                aria-label="Export calendar markdown zip"
                style={{ ...S.btn("rgba(59,130,246,0.12)"), border: "1px solid rgba(59,130,246,0.25)", flex: 1 }}
                onClick={handleExport}
              >
                {"\u2193"} Export
              </button>
              <button
                id="show-tasks-markdown"
                className="calendar-task-app__button calendar-task-app__show-markdown"
                type="button"
                aria-label="View raw tasks markdown"
                style={{ ...S.btn("rgba(148,163,184,0.12)"), border: "1px solid rgba(148,163,184,0.25)", flex: 1 }}
                onClick={openTasksMarkdown}
              >
                tasks.md
              </button>
              <button
                id="import-markdown"
                className="calendar-task-app__button calendar-task-app__import"
                type="button"
                aria-label="Import calendar markdown files"
                style={{ ...S.btn("rgba(168,85,247,0.12)"), border: "1px solid rgba(168,85,247,0.25)", flex: 1 }}
                onClick={() => importRef.current?.click()}
              >
                {"\u2191"} Import
              </button>
              <input
                ref={importRef}
                id="import-markdown-file-input"
                className="calendar-task-app__file-input"
                type="file"
                accept=".md,.zip,application/zip"
                multiple
                aria-label="Choose markdown or ZIP files to import"
                hidden
                onChange={handleImport}
              />
            </div>
            {importMsg && <div id="import-status" className="calendar-task-app__import-status" role="status" aria-live="polite" style={{ fontSize: 9, color: "#86efac", textAlign: "center", marginTop: 6, padding: "4px 8px", background: "rgba(34,197,94,0.1)", borderRadius: 6 }}>{importMsg}</div>}
          </section>
        </div>
          </>
        )}
      </section>

      {/* ═══ COL 4: COMPLETED ═══ */}
      <section
        data-nav-column="completed"
        data-nav-active={navColumn === "completed" ? "true" : "false"}
        id="completed-panel"
        className="calendar-task-app__panel calendar-task-app__panel--completed"
        role="region"
        aria-labelledby="completed-panel-title"
        tabIndex={-1}
        style={{ ...S.col, flex: isMobile ? "0 0 auto" : panelOpen.completed ? "24 1 0" : "0 0 12%", borderRight: "none", borderBottom: isMobile ? "none" : undefined, transition: "flex 0.2s ease" }}
        onFocusCapture={() => setNavColumn("completed")}
      >
        <button
          id="completed-panel-toggle"
          className="calendar-task-app__panel-toggle"
          type="button"
          data-panel-toggle
          title={panelOpen.completed ? "Collapse Completed panel" : "Expand Completed panel"}
          aria-expanded={panelOpen.completed}
          aria-controls={panelOpen.completed ? "completed-panel-content" : undefined}
          aria-label={`${panelOpen.completed ? "Collapse" : "Expand"} Completed panel`}
          onClick={() => togglePanel("completed")}
          style={{ ...S.iconBtn, ...S.colTitle, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 5, opacity: 1, padding: "0 0 10px", color: "rgba(255,255,255,0.3)" }}
        >
          <span aria-hidden="true" style={{ transform: panelOpen.completed ? "rotate(180deg)" : "none", transition: "transform 0.15s", fontSize: 10 }}>{"\u25BC"}</span>
          <span id="completed-panel-title" className="calendar-task-app__panel-title">Completed ({filteredCompleted.length})</span>
        </button>
        {panelOpen.completed && (
          <>
        <div id="completed-panel-content" className="calendar-task-app__panel-content calendar-task-app__completed" style={S.colScroll}>
        <div className="calendar-task-app__completed-date" aria-live="polite" style={{ textAlign: "center", marginBottom: 8, fontSize: 9, color: "rgba(255,255,255,0.25)" }}>{fmtDateDisplay(selectedDate)}</div>
        <div id="completed-task-list" className="calendar-task-app__completed-list" style={{ minHeight: 0 }} role="listbox" aria-label="Completed tasks" aria-orientation="vertical" aria-activedescendant={filteredCompleted[focusedCompletedIdx] ? `completed-task-card-${filteredCompleted[focusedCompletedIdx].id}-${focusedCompletedIdx}` : undefined}>
          {filteredCompleted.length === 0 ? (
            <div className="calendar-task-app__empty-state" role="status" style={{ textAlign: "center", padding: 24, fontSize: 10, color: "rgba(255,255,255,0.12)" }}>No completed tasks for this date.</div>
          ) : filteredCompleted.map((ct, idx) => {
            const noteKey = `c-${ct.id}-${ct.completedAt}`;
            const notesOpen = !!expandedNotes[noteKey];
            const listFocused = focusedCompletedIdx === idx;
            return (
              <div key={noteKey} className="calendar-task-app__completed-item" style={{ marginBottom: 6 }}>
                <div
                  ref={(el) => { completedCardRefs.current[idx] = el; }}
                  id={`completed-task-card-${ct.id}-${idx}`}
                  className={`calendar-task-app__completed-card${listFocused ? " calendar-task-app__completed-card--focused" : ""}`}
                  data-focusable-card
                  role="option"
                  aria-selected={listFocused}
                  tabIndex={listFocused ? 0 : -1}
                  aria-label={`Completed task T${ct.id}${ct.description ? `: ${ct.description}` : ""}`}
                  style={{ ...S.completedCard, marginBottom: 0, borderBottomLeftRadius: notesOpen ? 0 : 8, borderBottomRightRadius: notesOpen ? 0 : 8, cursor: "pointer" }}
                  onClick={() => {
                    setFocusedCompletedIdx(idx);
                    setNavColumn("completed");
                  }}
                  onFocus={() => {
                    setFocusedCompletedIdx(idx);
                    setNavColumn("completed");
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setFocusedCompletedIdx(idx);
                    }
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div className="calendar-task-app__task-badge" style={S.badge}>T<sub>{ct.id}</sub></div>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <div className="calendar-task-app__task-time" style={{ ...S.time, fontSize: 13 }}>{fmtTime(ct.timeOnTask)}</div>
                      <button
                        id={`toggle-completed-notes-${ct.id}-${idx}`}
                        className="calendar-task-app__icon-button calendar-task-app__completed-notes-toggle"
                        type="button"
                        tabIndex={listFocused ? 0 : -1}
                        title={notesOpen ? "Collapse notepad" : "Expand notepad"}
                        aria-expanded={notesOpen}
                        aria-controls={`completed-task-notes-${ct.id}-${idx}`}
                        aria-label={`${notesOpen ? "Collapse" : "Expand"} notes for completed task T${ct.id}`}
                        onClick={(e) => toggleTaskNotes(noteKey, e)}
                        style={{
                          ...S.iconBtn,
                          opacity: 0.85,
                          color: "#86efac",
                          fontSize: 10,
                          padding: "2px 4px",
                          transform: notesOpen ? "rotate(180deg)" : "none",
                          transition: "transform 0.15s",
                        }}
                      >
                        {"\u25BC"}
                      </button>
                    </div>
                  </div>
                  <div className="calendar-task-app__task-description" style={S.desc}>{ct.description || <em style={{ opacity: 0.5 }}>No description</em>}</div>
                </div>
                {notesOpen && (
                  <div
                    id={`completed-task-notes-${ct.id}-${idx}`}
                    className="calendar-task-app__completed-notes"
                    style={{
                      background: "rgba(134,239,172,0.18)",
                      border: "1px solid #22c55e",
                      borderTop: "none",
                      borderBottomLeftRadius: 8,
                      borderBottomRightRadius: 8,
                      padding: 8,
                      minHeight: 88,
                    }}
                  >
                    <textarea
                      id={`completed-task-notes-input-${ct.id}-${idx}`}
                      className="calendar-task-app__completed-notes-input"
                      value={ct.notes || ""}
                      aria-label={`Notes for completed task T${ct.id}`}
                      placeholder="Task notes..."
                      onChange={(e) => updateCompletedNotes(selectedDate, ct.completedAt, ct.id, e.target.value)}
                      style={{
                        ...S.input,
                        minHeight: 72,
                        resize: "vertical",
                        background: "transparent",
                        border: "none",
                        color: "#dcfce7",
                        fontSize: 11,
                        lineHeight: 1.45,
                        padding: 2,
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </div>
          </>
        )}
      </section>

      {/* ═══ DIALOGS ═══ */}

      {deleteDialog && (
        <ConfirmDialog
          dialogId="delete-task-dialog"
          title={<>Delete Task T<sub>{deleteDialog.id}</sub>?</>}
          confirmLabel="Delete"
          confirmStyle={S.btnDanger}
          initialFocus="cancel"
          onCancel={() => setDeleteDialog(null)}
          onConfirm={confirmDelete}
        >
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginBottom: 5 }}>{deleteDialog.description || "No description"} {"\u2014"} {fmtTime(deleteDialog.timeOnTask)}</div>
          <div style={{ fontSize: 10, color: "#fca5a5", marginBottom: 14 }}>This will permanently delete all data for this task.</div>
        </ConfirmDialog>
      )}

      {completeDialog && (
        <ConfirmDialog
          dialogId="complete-task-dialog"
          title={<>Complete Task T<sub>{completeDialog.id}</sub>?</>}
          confirmLabel="Complete"
          confirmStyle={{ background: "rgba(34,197,94,0.2)", border: "1px solid rgba(34,197,94,0.4)" }}
          onCancel={() => setCompleteDialog(null)}
          onConfirm={confirmComplete}
        >
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginBottom: 5 }}>{completeDialog.description || "No description"} {"\u2014"} {fmtTime(completeDialog.timeOnTask)}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginBottom: 14 }}>Started: {new Date(completeDialog.startDate).toLocaleString()}</div>
        </ConfirmDialog>
      )}

      {deleteAttDialog && (
        <ConfirmDialog
          dialogId="delete-attachment-dialog"
          title="Delete Attachment?"
          confirmLabel="Delete"
          confirmStyle={S.btnDanger}
          initialFocus="cancel"
          onCancel={() => setDeleteAttDialog(null)}
          onConfirm={confirmDeleteAtt}
        >
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginBottom: 14 }}>"{deleteAttDialog.name}"</div>
        </ConfirmDialog>
      )}

      {/* Zoom preview */}
      {zoomAtt && (
        <div
          id="attachment-zoom-dialog-overlay"
          className="calendar-task-app__modal-overlay calendar-task-app__attachment-zoom-overlay"
          style={S.dialog}
          onClick={() => setZoomAtt(null)}
        >
          <div
            ref={modalRef}
            id="attachment-zoom-dialog"
            className="calendar-task-app__modal calendar-task-app__attachment-zoom-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="attachment-zoom-dialog-title"
            style={{ position: "relative", maxWidth: "90vw", maxHeight: "90vh" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="calendar-task-app__attachment-zoom-controls" style={{ position: "absolute", top: -36, right: 0, display: "flex", gap: 6, alignItems: "center" }}>
              <button
                id="attachment-zoom-out"
                className="calendar-task-app__button calendar-task-app__zoom-control"
                type="button"
                aria-label="Zoom out"
                style={{ ...S.btn("rgba(255,255,255,0.15)"), padding: "4px 10px", fontSize: 14, fontWeight: 700 }}
                onClick={() => setZoomLevel((z) => Math.max(0.25, z - 0.25))}
              >
                -
              </button>
              <span id="attachment-zoom-level" className="calendar-task-app__zoom-level" aria-live="polite" style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", minWidth: 40, textAlign: "center" }}>{Math.round(zoomLevel * 100)}%</span>
              <button
                id="attachment-zoom-in"
                className="calendar-task-app__button calendar-task-app__zoom-control"
                type="button"
                aria-label="Zoom in"
                style={{ ...S.btn("rgba(255,255,255,0.15)"), padding: "4px 10px", fontSize: 14, fontWeight: 700 }}
                onClick={() => setZoomLevel((z) => Math.min(4, z + 0.25))}
              >
                +
              </button>
              <button
                ref={modalInitialFocusRef}
                id="close-attachment-zoom"
                className="calendar-task-app__button calendar-task-app__zoom-close"
                type="button"
                aria-label="Close image preview"
                style={{ ...S.btn("rgba(255,255,255,0.15)"), padding: "4px 10px", fontSize: 12 }}
                onClick={() => setZoomAtt(null)}
              >
                {"\u2715"}
              </button>
            </div>
            <div id="attachment-zoom-content" className="calendar-task-app__attachment-zoom-content" style={{ overflow: "auto", maxWidth: "90vw", maxHeight: "85vh", borderRadius: 8, background: "rgba(0,0,0,0.5)" }}>
              <img src={zoomAtt.dataUri} alt={`Preview of ${zoomAtt.name}`} style={{ transform: `scale(${zoomLevel})`, transformOrigin: "top left", display: "block" }} />
            </div>
            <h2 id="attachment-zoom-dialog-title" className="calendar-task-app__attachment-zoom-title" style={{ textAlign: "center", marginTop: 6, fontSize: 10, fontWeight: 400, color: "rgba(255,255,255,0.4)" }}>{zoomAtt.name}</h2>
          </div>
        </div>
      )}

      {showTasksMd && (
        <div
          id="tasks-markdown-dialog-overlay"
          className="calendar-task-app__modal-overlay calendar-task-app__tasks-markdown-overlay"
          style={S.dialog}
          onClick={() => setShowTasksMd(false)}
        >
          <div
            ref={modalRef}
            id="tasks-markdown-dialog"
            className="calendar-task-app__modal calendar-task-app__tasks-markdown-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="tasks-markdown-dialog-title"
            style={{ ...S.dialogBox, maxWidth: 600, maxHeight: "85vh", overflow: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h2 id="tasks-markdown-dialog-title" className="calendar-task-app__modal-title" style={{ fontSize: 13, fontWeight: 700 }}>tasks.md (raw)</h2>
              <button
                ref={modalInitialFocusRef}
                id="close-tasks-markdown"
                className="calendar-task-app__icon-button"
                type="button"
                style={S.iconBtn}
                onClick={() => setShowTasksMd(false)}
                aria-label="Close tasks.md"
              >
                {"\u2715"}
              </button>
            </div>
            <pre id="tasks-markdown-content" className="calendar-task-app__tasks-markdown-content" tabIndex={0} aria-label="Raw tasks markdown" style={{ ...S.input, maxHeight: "60vh", overflow: "auto", whiteSpace: "pre-wrap", fontSize: 8, lineHeight: 1.5, padding: "12px 14px" }}>
              {tasksToMarkdown(tasks, completedTasks)}
            </pre>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
              <button
                id="export-all-markdown"
                className="calendar-task-app__button calendar-task-app__export-all"
                type="button"
                aria-label="Export all calendar markdown"
                style={{ ...S.btn("rgba(59,130,246,0.12)"), border: "1px solid rgba(59,130,246,0.25)" }}
                onClick={handleExport}
              >
                {"\u2193"} Export all
              </button>
            </div>
          </div>
        </div>
      )}

    </main>
  );
}
