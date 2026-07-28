import { useState, useEffect, useRef, useMemo } from "react";
import {
  saveTasks, loadTasks, saveNote, loadNote, loadNoteRaw,
  saveSettings, loadSettings, exportAllMarkdownZip,
  importMarkdownFiles, parseZip,
  saveAttachments, loadAttachments, renderMarkdown,
  weekKey, weekRange, fmtTime, tasksToMarkdown,
} from "./markdownDb.js";

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
const getMonday = (d) => {
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.getFullYear(), d.getMonth(), diff);
};

/* =========================================================
   AUDIO — Musical tones per spec
   ========================================================= */
function createTonePlayer() {
  let ctx = null;
  const getCtx = () => {
    if (!ctx || ctx.state === "closed") ctx = new (window.AudioContext || window.webkitAudioContext)();
    return ctx;
  };

  // 5/4 time at 120 BPM: quarter = 0.5s, eighth = 0.25s, half = 1.0s
  const playNote = (freq, startTime, duration, gain = 0.25) => {
    const c = getCtx();
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    g.gain.value = gain;
    // gentle fade out
    g.gain.setValueAtTime(gain, startTime);
    g.gain.exponentialRampToValueAtTime(0.01, startTime + duration - 0.02);
    osc.connect(g);
    g.connect(c.destination);
    osc.start(startTime);
    osc.stop(startTime + duration);
  };

  return {
    // 300s timer complete: 5 quarter notes, low Db (Db3 = 138.59 Hz), 5/4
    timerComplete: () => {
      try {
        const c = getCtx();
        const now = c.currentTime;
        const freq = 138.59; // Db3
        for (let i = 0; i < 5; i++) {
          playNote(freq, now + i * 0.5, 0.4);
        }
      } catch (e) {}
    },

    // 25 min pomodoro complete: 5 eighth notes x 4 groups (20 total), Bb (Bb3 = 233.08 Hz)
    pomodoroComplete: () => {
      try {
        const c = getCtx();
        const now = c.currentTime;
        const freq = 233.08; // Bb3
        let t = now;
        for (let group = 0; group < 4; group++) {
          for (let n = 0; n < 5; n++) {
            playNote(freq, t, 0.2);
            t += 0.25; // eighth note
          }
          t += 0.15; // small gap between groups
        }
      } catch (e) {}
    },

    // 5 min break complete: 2 half notes, Fb (= E4 = 329.63 Hz)
    breakComplete: () => {
      try {
        const c = getCtx();
        const now = c.currentTime;
        const freq = 329.63; // E4 (enharmonic Fb)
        playNote(freq, now, 0.9, 0.2);
        playNote(freq, now + 1.0, 0.9, 0.2);
      } catch (e) {}
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
function PlayPauseButton({ running, onToggle, style }) {
  return (
    <button
      onClick={onToggle}
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
function ConfirmDialog({ title, children, confirmLabel, confirmStyle, onConfirm, onCancel, initialFocus = "confirm" }) {
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
    <div style={DIALOG_STYLE.overlay} onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        style={DIALOG_STYLE.box}
        onClick={(e) => e.stopPropagation()}
      >
        <div id="confirm-dialog-title" style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>{title}</div>
        {children}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button ref={cancelRef} type="button" style={DIALOG_STYLE.btn()} onClick={onCancel}>Cancel</button>
          <button ref={confirmRef} type="button" style={{ ...DIALOG_STYLE.btn(), ...confirmStyle }} onClick={onConfirm}>{confirmLabel}</button>
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

  /* pomodoro — own running state, does not drive the 300s timer */
  const [pomodoroSeconds, setPomodoroSeconds] = useState(0);
  const [pomodoroPhase, setPomodoroPhase] = useState("work");
  const [pomodoroCount, setPomodoroCount] = useState(0);
  const [pomodoroRunning, setPomodoroRunning] = useState(false);
  const pomodoroRef = useRef(null);

  /* notes + attachments (per-week) */
  const [noteContent, setNoteContent] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [selectedAttId, setSelectedAttId] = useState(null);
  const fileRef = useRef(null);
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
  const [showMdPreview, setShowMdPreview] = useState(false);
  const [zoomAtt, setZoomAtt] = useState(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [importMsg, setImportMsg] = useState(null);
  const importRef = useRef(null);
  const [isToday, setIsToday] = useState(true);

  /* column / list keyboard navigation */
  const [navColumn, setNavColumn] = useState("tasks");
  const [focusedTaskIdx, setFocusedTaskIdx] = useState(0);
  const [focusedAttIdx, setFocusedAttIdx] = useState(0);
  const [focusedCompletedIdx, setFocusedCompletedIdx] = useState(0);
  const taskCardRefs = useRef([]);
  const attCardRefs = useRef([]);
  const completedCardRefs = useRef([]);
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
  const prevWeekKey = useRef(null);

  useEffect(() => {
    const { activeTasks, completedTasks: ct } = loadTasks();
    const settings = loadSettings();
    setTasks(activeTasks);
    setCompletedTasks(ct);
    setNextTaskId(settings.nextTaskId ?? (activeTasks.length ? Math.max(...activeTasks.map((t) => t.id)) + 1 : 0));
    setNextAttId(settings.nextAttId ?? 0);
    setPomodoroCount(settings.pomodoroCount ?? 0);
    const td = todayStr();
    setNoteContent(loadNote(td));
    setAttachments(loadAttachments(td));
    prevWeekKey.current = weekKey(td);
    setLastSynced(new Date());
    requestAnimationFrame(() => { hydrated.current = true; });
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    setDirty(true);
  }, [tasks, completedTasks, noteContent, attachments, nextTaskId, nextAttId, pomodoroCount]);

  const syncToStorage = () => {
    saveTasks(tasks, completedTasks);
    saveSettings({ nextTaskId, nextAttId, pomodoroCount });
    saveNote(selectedDate, noteContent);
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

  /* week change — swap notes + attachments */
  useEffect(() => {
    if (!hydrated.current) return;
    const newWk = weekKey(selectedDate);
    const oldWk = prevWeekKey.current;
    if (oldWk && oldWk !== newWk) {
      const oldRange = weekRange(selectedDate);
      localStorage.setItem("md:notes:" + oldWk, "# " + oldWk + " \u2014 " + oldRange + "\n\n" + noteContent);
      localStorage.setItem("md:attachments:" + oldWk, JSON.stringify(attachments));
      setNoteContent(loadNote(selectedDate));
      setAttachments(loadAttachments(selectedDate));
      setSelectedAttId(null);
    }
    prevWeekKey.current = newWk;
  }, [weekKey(selectedDate)]);

  /* track isToday */
  useEffect(() => {
    setIsToday(selectedDate === todayStr());
  }, [selectedDate]);

  /* ═══ 300s TIMER (task time) ═══ */
  useEffect(() => {
    if (timerRunning) {
      timerRef.current = setInterval(() => {
        setTimerSeconds((prev) => {
          const next = prev + 1;
          if (next >= 300) {
            audio.timerComplete();
            setTimeout(() => setTimerSeconds(0), 100);
            return 0;
          }
          return next;
        });
        setTasks((prev) =>
          prev.map((t) => t.id === selectedTaskId ? { ...t, timeOnTask: t.timeOnTask + 1 } : t)
        );
      }, 1000);
    }
    return () => clearInterval(timerRef.current);
  }, [timerRunning, selectedTaskId]);

  /* ═══ POMODORO (independent) ═══ */
  useEffect(() => {
    if (pomodoroRunning) {
      pomodoroRef.current = setInterval(() => {
        setPomodoroPhase((phase) => {
          if (phase === "breakPending") return phase;
          setPomodoroSeconds((ps) => {
            const limit = phase === "work" ? 1500 : 300;
            const next = ps + 1;
            if (next >= limit) {
              if (phase === "work") {
                audio.pomodoroComplete();
                setPomodoroRunning(false);
                setPomodoroPhase("breakPending");
                setPomodoroCount((c) => c + 1);
                return 0;
              } else {
                audio.breakComplete();
                setPomodoroRunning(false);
                setPomodoroPhase("work");
                return 0;
              }
            }
            return next;
          });
          return phase;
        });
      }, 1000);
    }
    return () => clearInterval(pomodoroRef.current);
  }, [pomodoroRunning]);

  const toggleTimer = () => {
    setTimerRunning((r) => !r);
    syncToStorage();
  };

  const togglePomodoro = () => {
    if (!pomodoroRunning && pomodoroPhase === "breakPending") {
      setPomodoroPhase("break");
      setPomodoroSeconds(0);
    }
    setPomodoroRunning((r) => !r);
    syncToStorage();
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
    if (!file || !["image/png", "image/jpeg"].includes(file.type)) return;
    const reader = new FileReader();
    reader.onload = () => {
      const id = nextAttId;
      setNextAttId((n) => n + 1);
      setAttachments((prev) => [...prev, { id, name: file.name, mimeType: file.type, dataUri: reader.result, createdAt: new Date().toISOString() }]);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };
  const confirmDeleteAtt = () => {
    if (!deleteAttDialog) return;
    setAttachments((prev) => prev.filter((a) => a.id !== deleteAttDialog.id));
    if (selectedAttId === deleteAttDialog.id) setSelectedAttId(null);
    setDeleteAttDialog(null);
  };
  const openZoom = (att) => { setZoomAtt(att); setZoomLevel(1); };

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
  const selectDay = (day) => {
    if (!day) return;
    setSelectedDate(calYear + "-" + String(calMonth + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0"));
  };
  const goToday = () => {
    const td = todayStr();
    setSelectedDate(td);
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
      if (notesImported > 0) setNoteContent(loadNote(selectedDate));

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

  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const filteredCompletedRef = useRef(filteredCompleted);
  filteredCompletedRef.current = filteredCompleted;
  const overlayOpenRef = useRef(false);
  overlayOpenRef.current = !!(deleteDialog || completeDialog || deleteAttDialog || zoomAtt || showMdPreview);

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
    app: { display: "flex", height: "100vh", fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace", background: "#0a0f1a", color: "#e2e8f0", overflow: "hidden", fontSize: 13 },
    col: { flex: 1, display: "flex", flexDirection: "column", padding: "10px 10px", overflow: "hidden", borderRight: "1px dashed rgba(255,255,255,0.08)" },
    colScroll: { flex: 1, overflowY: "auto", overflowX: "hidden", padding: "2px 4px 2px 2px" },
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
    <div style={S.app}>
      <style>{`
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&display=swap');
        textarea:focus, input:focus {
          outline: none;
          box-shadow: inset 0 0 0 1.5px rgba(249,115,22,0.85);
        }
        button:focus-visible {
          outline: none;
          box-shadow: inset 0 0 0 2px rgba(249,115,22,0.85);
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
        .md-render h1 { font-size: 16px; font-weight: 800; margin: 12px 0 6px; color: #f97316; }
        .md-render h2 { font-size: 14px; font-weight: 700; margin: 10px 0 4px; color: #fb923c; }
        .md-render h3 { font-size: 12px; font-weight: 700; margin: 8px 0 4px; color: #fdba74; }
        .md-render blockquote { border-left: 3px solid rgba(255,255,255,0.15); padding-left: 10px; margin: 6px 0; opacity: 0.6; }
        .md-render ul { padding-left: 18px; margin: 4px 0; }
        .md-render li { margin: 2px 0; }
        .md-render strong { color: #e2e8f0; }
        .md-render em { color: rgba(255,255,255,0.5); }
      `}</style>

      {/* ═══ COL 1: TASKS ═══ */}
      <div
        data-nav-column="tasks"
        data-nav-active={navColumn === "tasks" ? "true" : "false"}
        tabIndex={-1}
        style={{ ...S.col, flex: "0 0 22%" }}
        onFocusCapture={() => setNavColumn("tasks")}
      >
        <div style={S.colTitle}>Tasks</div>
        <div style={S.colScroll} role="listbox" aria-label="Tasks">
          {tasks.map((task, idx) => {
            const sel = task.id === selectedTaskId;
            const notesOpen = !!expandedNotes[task.id];
            const listFocused = focusedTaskIdx === idx;
            return (
              <div key={task.id} style={{ marginBottom: 6 }}>
                <div
                  ref={(el) => { taskCardRefs.current[idx] = el; }}
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
                    <div style={S.badge}>T<sub>{task.id}</sub></div>
                    <div style={{ display: "flex", gap: 2 }}>
                      <button type="button" tabIndex={listFocused ? 0 : -1} style={S.iconBtn} title="Complete" onClick={(e) => { e.stopPropagation(); setCompleteDialog(task); }}>{"\u2713"}</button>
                      <button type="button" tabIndex={listFocused ? 0 : -1} style={{ ...S.iconBtn, color: sel ? "#fca5a5" : "#f87171" }} title="Delete" onClick={(e) => { e.stopPropagation(); setDeleteDialog(task); }}>{"\u2715"}</button>
                    </div>
                  </div>
                  {editingDesc === task.id ? (
                    <input autoFocus style={S.input} defaultValue={task.description} placeholder="Task description..."
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => { setTasks((prev) => prev.map((t) => t.id === task.id ? { ...t, description: e.target.value } : t)); setEditingDesc(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEditingDesc(null); }} />
                  ) : (
                    <div style={S.desc} onDoubleClick={(e) => { e.stopPropagation(); setEditingDesc(task.id); }}>
                      {task.description || <span style={{ opacity: 0.4, fontStyle: "italic" }}>Double-click to edit...</span>}
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: 3 }}>
                    <div style={{ ...S.time, fontSize: 14 }}>{fmtTime(task.timeOnTask)}</div>
                    <button
                      type="button"
                      tabIndex={listFocused ? 0 : -1}
                      title={notesOpen ? "Collapse notepad" : "Expand notepad"}
                      aria-expanded={notesOpen}
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
                      value={task.notes || ""}
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
        <button style={{ ...S.btn("rgba(34,197,94,0.15)"), border: "1px dashed rgba(34,197,94,0.4)", marginTop: 6, width: "100%" }} onClick={addTask}>+ Add Task</button>
      </div>

      {/* ═══ COL 2: WIDGETS ═══ */}
      <div
        ref={widgetsColRef}
        data-nav-column="widgets"
        data-nav-active={navColumn === "widgets" ? "true" : "false"}
        tabIndex={-1}
        style={{ ...S.col, flex: "0 0 30%" }}
        onFocusCapture={() => setNavColumn("widgets")}
      >
        <div style={S.colTitle}>Widgets</div>
        <div style={S.colScroll}>

          {/* --- TOP ROW: Today + Date + Play/Pause --- */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <button
              onClick={goToday}
              style={{
                ...S.btn(isToday ? "rgba(34,197,94,0.2)" : "rgba(249,115,22,0.2)"),
                border: `1px solid ${isToday ? "rgba(34,197,94,0.5)" : "rgba(249,115,22,0.5)"}`,
                color: isToday ? "#86efac" : "#fb923c",
                padding: "5px 10px", fontSize: 10, fontWeight: 700, flexShrink: 0,
              }}
            >
              {isToday ? "\u2713 today" : "today"}
            </button>
            <span style={{ ...S.chip, flex: 1, justifyContent: "center", fontSize: 11 }}>
              {fmtDateDisplay(selectedDate)}
            </span>
            <PlayPauseButton running={timerRunning} onToggle={toggleTimer} />
          </div>

          {/* --- SYNC --- */}
          <button
            onClick={syncToStorage}
            style={{
              ...S.btn(dirty ? "rgba(249,115,22,0.15)" : "rgba(34,197,94,0.1)"),
              border: `1px solid ${dirty ? "rgba(249,115,22,0.4)" : "rgba(34,197,94,0.3)"}`,
              color: dirty ? "#fb923c" : "#86efac",
              width: "100%", padding: "5px 10px", fontSize: 9, marginBottom: 8,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            }}
          >
            <span style={{ fontSize: 11 }}>{dirty ? "\u25CF" : "\u2713"}</span>
            {dirty ? "SYNC" : "SYNCED"}
            {lastSynced && <span style={{ opacity: 0.4, marginLeft: 4 }}>{lastSynced.toLocaleTimeString()}</span>}
          </button>

          {/* --- Calendar --- */}
          <div style={S.section}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <button style={S.iconBtn} onClick={prevMonth}>{"\u25C2"}</button>
              <span style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.5)" }}>
                {new Date(calYear, calMonth).toLocaleString("en-US", { month: "long", year: "numeric" })}
              </span>
              <button style={S.iconBtn} onClick={nextMonth}>{"\u25B8"}</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, textAlign: "center" }}>
              {["M", "T", "W", "R", "F", "S", "S"].map((d, i) => (
                <div key={i} style={{ fontSize: 8, fontWeight: 700, color: "rgba(255,255,255,0.2)", padding: "2px 0" }}>{d}</div>
              ))}
              {calDays.map((day, i) => (
                <div key={i} onClick={() => selectDay(day)} style={{
                  padding: "4px 0", borderRadius: 6, fontSize: 10, fontWeight: 600,
                  cursor: day ? "pointer" : "default",
                  background: isDaySelected(day) ? "#f97316" : isSelectedWeek(day) ? "rgba(249,115,22,0.1)" : isCurrentWeek(day) ? "rgba(147,197,253,0.08)" : "transparent",
                  color: isDaySelected(day) ? "#fff" : day ? "rgba(255,255,255,0.55)" : "transparent",
                  transition: "all 0.15s",
                }}>{day || ""}</div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 6, justifyContent: "center" }}>
              <input type="date" value={selectedDate} onChange={(e) => { setSelectedDate(e.target.value); const d = new Date(e.target.value + "T12:00:00"); setCalMonth(d.getMonth()); setCalYear(d.getFullYear()); }} style={{ ...S.input, width: "auto", fontSize: 9, padding: "2px 6px" }} />
            </div>
          </div>

          {/* --- 300s Timer Grid --- */}
          <div style={{ ...S.section, borderColor: "rgba(249,115,22,0.12)" }}>
            <div style={{ ...S.sectionLabel, color: "rgba(249,115,22,0.5)" }}>300s Timer {"\u2014"} {timerSeconds}/300</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(30, 1fr)", gap: 1.5 }}>
              {circles.map((filled, i) => (
                <div key={i} style={{ width: "100%", paddingTop: "100%", borderRadius: "50%", background: filled ? "#f97316" : "rgba(255,255,255,0.04)", border: "1px solid " + (filled ? "#fb923c" : "rgba(255,255,255,0.06)"), transition: "background 0.2s" }} />
              ))}
            </div>
          </div>

          {/* --- Pomodoro --- */}
          <div style={{
            ...S.section,
            borderColor: pomodoroRunning ? "rgba(220,38,38,0.45)" : "rgba(255,255,255,0.08)",
            transition: "border-color 0.2s",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, gap: 6 }}>
              <div style={{
                ...S.sectionLabel,
                color: pomodoroRunning ? "#dc2626" : "rgba(255,255,255,0.28)",
                marginBottom: 0,
                flex: 1,
                transition: "color 0.2s",
              }}>
                {pomodoroRunning ? "\uD83C\uDF45" : "\uD83E\uDD6B"}{" "}
                {pomodoroLabel}
              </div>
              <PlayPauseButton
                running={pomodoroRunning}
                onToggle={togglePomodoro}
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
              <span style={{ fontSize: 9, width: 34, color: pomodoroRunning ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.25)" }}>Focus</span>
              <div style={{ flex: 1, height: 7, background: "rgba(255,255,255,0.04)", borderRadius: 4, overflow: "hidden" }}>
                <div style={{ width: (pomodoroPhase === "work" ? (pomodoroSeconds / 1500) * 100 : pomodoroPhase === "breakPending" ? 100 : 0) + "%", height: "100%", background: pomodoroRunning ? "linear-gradient(90deg, #dc2626, #f97316)" : "rgba(255,255,255,0.2)", borderRadius: 4, transition: "width 0.5s, background 0.2s" }} />
              </div>
              <span style={{ fontSize: 9, width: 44, textAlign: "right", fontVariantNumeric: "tabular-nums", color: pomodoroRunning ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.25)" }}>
                {pomodoroPhase === "work" ? fmtTime(pomodoroSeconds) : pomodoroPhase === "breakPending" ? "25:00" : "\u2014"}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, opacity: pomodoroRunning && pomodoroPhase === "break" ? 1 : 0.45, transition: "opacity 0.2s" }}>
              <span style={{ fontSize: 9, width: 34, color: "rgba(255,255,255,0.35)" }}>Break</span>
              <div style={{ flex: 1, height: 7, background: "rgba(255,255,255,0.04)", borderRadius: 4, overflow: "hidden" }}>
                <div style={{ width: (pomodoroPhase === "break" ? (pomodoroSeconds / 300) * 100 : 0) + "%", height: "100%", background: pomodoroRunning ? "linear-gradient(90deg, #2563eb, #7c3aed)" : "rgba(255,255,255,0.2)", borderRadius: 4, transition: "width 0.5s, background 0.2s" }} />
              </div>
              <span style={{ fontSize: 9, width: 44, textAlign: "right", fontVariantNumeric: "tabular-nums", color: "rgba(255,255,255,0.35)" }}>
                {pomodoroPhase === "break" ? fmtTime(pomodoroSeconds) : "\u2014"}
              </span>
            </div>
            <div style={{ textAlign: "center", marginTop: 6, fontSize: 10, color: "rgba(255,255,255,0.25)" }}>
              Completed: <strong style={{ color: pomodoroRunning ? "#f97316" : "rgba(255,255,255,0.35)" }}>{pomodoroCount}</strong> pomodoros
            </div>
          </div>
        </div>
      </div>

      {/* ═══ COL 3: ATTACHMENTS + NOTES ═══ */}
      <div
        data-nav-column="attachments"
        data-nav-active={navColumn === "attachments" ? "true" : "false"}
        tabIndex={-1}
        style={{ ...S.col, flex: "0 0 24%" }}
        onFocusCapture={() => setNavColumn("attachments")}
      >
        <div style={S.colTitle}>Attachments & Notes</div>
        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", textAlign: "center", marginBottom: 8 }}>{currentWeekKey} {"\u2014"} {currentWeekRange}</div>
        <div style={S.colScroll}>

          {/* Camera/upload */}
          <div onClick={() => fileRef.current?.click()} style={{ border: "2px dashed rgba(59,130,246,0.25)", borderRadius: 10, padding: 12, textAlign: "center", cursor: "pointer", marginBottom: 8 }}>
            <div style={{ fontSize: 20, marginBottom: 1 }}>{"\uD83D\uDCF7"}</div>
            <div style={{ fontSize: 8, color: "rgba(255,255,255,0.3)" }}>Click to add image</div>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg" hidden onChange={handleFileSelect} />
          </div>

          {/* Attachment list */}
          <div role="listbox" aria-label="Attachments">
          {attachments.map((att, idx) => {
            const listFocused = focusedAttIdx === idx;
            return (
            <div
              key={att.id}
              ref={(el) => { attCardRefs.current[idx] = el; }}
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
              <img
                src={att.dataUri} alt=""
                style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 4, flexShrink: 0, cursor: "zoom-in" }}
                onClick={(e) => { e.stopPropagation(); openZoom(att); }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                {editingAttName === att.id ? (
                  <input autoFocus style={{ ...S.input, fontSize: 9 }} defaultValue={att.name}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => { setAttachments((prev) => prev.map((a) => a.id === att.id ? { ...a, name: e.target.value } : a)); setEditingAttName(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }} />
                ) : (
                  <div style={{ fontSize: 9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} onDoubleClick={(e) => { e.stopPropagation(); setEditingAttName(att.id); }} title={att.name}>{att.name}</div>
                )}
              </div>
              <button type="button" tabIndex={listFocused ? 0 : -1} style={{ ...S.iconBtn, color: "#f87171", fontSize: 11 }} onClick={(e) => { e.stopPropagation(); setDeleteAttDialog(att); }}>{"\u2715"}</button>
            </div>
            );
          })}
          </div>

          {/* Small inline preview */}
          {selectedAtt && (
            <div
              style={{ border: "2px dashed rgba(59,130,246,0.3)", borderRadius: 10, padding: 6, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 6, marginBottom: 8, cursor: "zoom-in" }}
              onClick={() => openZoom(selectedAtt)}
            >
              <img src={selectedAtt.dataUri} alt="" style={{ maxWidth: "100%", maxHeight: 140, objectFit: "contain", borderRadius: 6 }} />
            </div>
          )}

          {/* --- WEEKLY NOTES --- */}
          <div style={{ ...S.section, borderColor: "rgba(168,85,247,0.15)", marginTop: 6 }}>
            <div style={{ ...S.sectionLabel, color: "rgba(168,85,247,0.6)" }}>Notes {"\u2014"} {currentWeekKey}</div>
            <textarea
              value={noteContent}
              onChange={(e) => setNoteContent(e.target.value)}
              placeholder={"Notes for " + currentWeekRange + "..."}
              style={{ ...S.input, minHeight: 140, resize: "vertical", lineHeight: 1.6, fontSize: 11, padding: "8px 10px" }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
              <button style={{ ...S.btn(), fontSize: 8, padding: "2px 8px" }} onClick={() => setShowMdPreview(true)}>Preview</button>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button style={{ ...S.btn("rgba(59,130,246,0.12)"), border: "1px solid rgba(59,130,246,0.25)", flex: 1 }} onClick={handleExport}>{"\u2193"} Export</button>
              <button style={{ ...S.btn("rgba(168,85,247,0.12)"), border: "1px solid rgba(168,85,247,0.25)", flex: 1 }} onClick={() => importRef.current?.click()}>{"\u2191"} Import</button>
              <input ref={importRef} type="file" accept=".md,.zip,application/zip" multiple hidden onChange={handleImport} />
            </div>
            {importMsg && <div style={{ fontSize: 9, color: "#86efac", textAlign: "center", marginTop: 6, padding: "4px 8px", background: "rgba(34,197,94,0.1)", borderRadius: 6 }}>{importMsg}</div>}
          </div>
        </div>
      </div>

      {/* ═══ COL 4: COMPLETED ═══ */}
      <div
        data-nav-column="completed"
        data-nav-active={navColumn === "completed" ? "true" : "false"}
        tabIndex={-1}
        style={{ ...S.col, flex: "0 0 24%", borderRight: "none" }}
        onFocusCapture={() => setNavColumn("completed")}
      >
        <div style={S.colTitle}>Completed</div>
        <div style={{ textAlign: "center", marginBottom: 8, fontSize: 9, color: "rgba(255,255,255,0.25)" }}>{fmtDateDisplay(selectedDate)}</div>
        <div style={S.colScroll} role="listbox" aria-label="Completed tasks">
          {filteredCompleted.length === 0 ? (
            <div style={{ textAlign: "center", padding: 24, fontSize: 10, color: "rgba(255,255,255,0.12)" }}>No completed tasks for this date.</div>
          ) : filteredCompleted.map((ct, idx) => {
            const noteKey = `c-${ct.id}-${ct.completedAt}`;
            const notesOpen = !!expandedNotes[noteKey];
            const listFocused = focusedCompletedIdx === idx;
            return (
              <div key={noteKey} style={{ marginBottom: 6 }}>
                <div
                  ref={(el) => { completedCardRefs.current[idx] = el; }}
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
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div style={S.badge}>T<sub>{ct.id}</sub></div>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <div style={{ ...S.time, fontSize: 13 }}>{fmtTime(ct.timeOnTask)}</div>
                      <button
                        type="button"
                        tabIndex={listFocused ? 0 : -1}
                        title={notesOpen ? "Collapse notepad" : "Expand notepad"}
                        aria-expanded={notesOpen}
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
                  <div style={S.desc}>{ct.description || <em style={{ opacity: 0.5 }}>No description</em>}</div>
                </div>
                {notesOpen && (
                  <div
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
                      value={ct.notes || ""}
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

      {/* ═══ DIALOGS ═══ */}

      {deleteDialog && (
        <ConfirmDialog
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
        <div style={S.dialog} onClick={() => setZoomAtt(null)}>
          <div style={{ position: "relative", maxWidth: "90vw", maxHeight: "90vh" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ position: "absolute", top: -36, right: 0, display: "flex", gap: 6, alignItems: "center" }}>
              <button style={{ ...S.btn("rgba(255,255,255,0.15)"), padding: "4px 10px", fontSize: 14, fontWeight: 700 }} onClick={() => setZoomLevel((z) => Math.max(0.25, z - 0.25))}>-</button>
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", minWidth: 40, textAlign: "center" }}>{Math.round(zoomLevel * 100)}%</span>
              <button style={{ ...S.btn("rgba(255,255,255,0.15)"), padding: "4px 10px", fontSize: 14, fontWeight: 700 }} onClick={() => setZoomLevel((z) => Math.min(4, z + 0.25))}>+</button>
              <button style={{ ...S.btn("rgba(255,255,255,0.15)"), padding: "4px 10px", fontSize: 12 }} onClick={() => setZoomAtt(null)}>{"\u2715"}</button>
            </div>
            <div style={{ overflow: "auto", maxWidth: "90vw", maxHeight: "85vh", borderRadius: 8, background: "rgba(0,0,0,0.5)" }}>
              <img src={zoomAtt.dataUri} alt="" style={{ transform: `scale(${zoomLevel})`, transformOrigin: "top left", display: "block" }} />
            </div>
            <div style={{ textAlign: "center", marginTop: 6, fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{zoomAtt.name}</div>
          </div>
        </div>
      )}

      {/* Markdown Preview — rendered */}
      {showMdPreview && (
        <div style={S.dialog} onClick={() => setShowMdPreview(false)}>
          <div style={{ ...S.dialogBox, maxWidth: 600, maxHeight: "85vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>Weekly Notes Preview</span>
              <button style={S.iconBtn} onClick={() => setShowMdPreview(false)}>{"\u2715"}</button>
            </div>

            <div style={{ fontSize: 10, fontWeight: 700, color: "rgba(168,85,247,0.6)", marginBottom: 6 }}>{currentWeekKey} {"\u2014"} {currentWeekRange}</div>

            {/* Rendered note content */}
            <div
              className="md-render"
              style={{ ...S.input, minHeight: 80, padding: "12px 14px", fontSize: 11, lineHeight: 1.7 }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(noteContent || "") }}
            />

            <div style={{ marginTop: 14, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.35)" }}>tasks.md (raw)</span>
                <button style={{ ...S.btn(), fontSize: 8, padding: "2px 8px" }} onClick={handleExport}>{"\u2193"} Export all</button>
              </div>
              <pre style={{ ...S.input, maxHeight: 150, overflow: "auto", whiteSpace: "pre-wrap", fontSize: 8, lineHeight: 1.5 }}>
                {tasksToMarkdown(tasks, completedTasks)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
