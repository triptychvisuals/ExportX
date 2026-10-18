#!/usr/bin/env python3
"""
ExportX batch exporter, Python edition.

Queues Resolve render jobs from the same JSON deliverable profiles as the
ExportX panel (see ../profiles and docs/PROFILES.md):

  target "timeline"  one job for the whole timeline (final exports)
  target "cuts"      one ranged job per cut marker made with the ExportX pad
  target "stills"    one single-frame job per still marker

Cuts and stills are ordinary Resolve timeline markers whose customData is
"exportx:cut" / "exportx:still", so anything the panel marked is visible here
and vice versa. Use --mark-cut / --mark-still to add them from the command line.

Two ways to run it:

1. Inside DaVinci Resolve (free or Studio)
   Copy this file to your Fusion scripts folder and run it from
   Workspace > Scripts. Configure through environment variables or by editing
   the CONFIG block below, since the Scripts menu passes no arguments.
     macOS:   ~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/
     Windows: %APPDATA%\\Blackmagic Design\\DaVinci Resolve\\Support\\Fusion\\Scripts\\Utility\\
     Linux:   ~/.local/share/DaVinciResolve/Fusion/Scripts/Utility/

2. From a terminal (Resolve Studio, external scripting enabled)
     python3 exportx_batch.py --list
     python3 exportx_batch.py --all --out "/Volumes/Deliver/Job123" --wait
     python3 exportx_batch.py --targets stills --out ~/Deliver --render
     python3 exportx_batch.py --mark-cut 01:00:04:00 01:00:09:12 --mark-still 01:00:12:05

Environment variables honoured in both modes:
   EXPORTX_OUT           output folder
   EXPORTX_PROFILES      comma-separated profile ids (default: profiles with enabledByDefault)
   EXPORTX_TARGETS       comma-separated subset of timeline,cuts,stills (default: all)
   EXPORTX_PROFILE_DIRS  os.pathsep-separated extra profile directories
   EXPORTX_TEMPLATE      filename template (default {timeline}_{profile})
   EXPORTX_RENDER        "1" to start rendering after queuing
   EXPORTX_HOME          overrides ~/.exportx
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sys
import time
from pathlib import Path

# ----------------------------------------------------------------- CONFIG
# Used when running from Resolve's Scripts menu and no env vars are set.
CONFIG = {
    "out": "",                        # e.g. "/Volumes/Deliver/Job123"
    "profiles": [],                   # e.g. ["final-4k-h265", "stills-tiff"]; [] = enabledByDefault ones
    "targets": [],                    # e.g. ["stills"]; [] = all
    "template": "{yymmdd}_{project}_{label}",
    "underscore_spaces": True,
    "render": True,
    "wait": True,
    "clear_queue": False,
}

DEFAULT_TEMPLATE = "{yymmdd}_{project}_{label}"
TARGETS = ("timeline", "cuts", "stills")
TERMINAL = {"complete", "failed", "cancelled"}
UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
MARK_KINDS = {
    "cut": {"customData": "exportx:cut", "color": "Cyan", "label": "Cut"},
    "still": {"customData": "exportx:still", "color": "Pink", "label": "Still"},
}
AUTO_CODEC = re.compile(r"^(auto|\*|first|default)$", re.I)


# ----------------------------------------------------------------- Resolve connection

def _add_default_script_paths() -> None:
    candidates = []
    env_api = os.environ.get("RESOLVE_SCRIPT_API")
    if env_api:
        candidates.append(os.path.join(env_api, "Modules"))
    if sys.platform == "darwin":
        candidates.append("/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules")
    elif sys.platform.startswith("win"):
        pd = os.environ.get("PROGRAMDATA", r"C:\ProgramData")
        candidates.append(os.path.join(pd, "Blackmagic Design", "DaVinci Resolve", "Support", "Developer", "Scripting", "Modules"))
    else:
        candidates.append("/opt/resolve/Developer/Scripting/Modules")
    for c in candidates:
        if os.path.isdir(c) and c not in sys.path:
            sys.path.append(c)


def get_resolve():
    """Return the Resolve scripting object, inside or outside Resolve."""
    existing = globals().get("resolve")
    if existing:
        return existing
    try:
        import DaVinciResolveScript as dvr  # type: ignore
    except ImportError:
        _add_default_script_paths()
        try:
            import DaVinciResolveScript as dvr  # type: ignore
        except ImportError as err:
            raise SystemExit(
                "Could not import DaVinciResolveScript. Set RESOLVE_SCRIPT_API / RESOLVE_SCRIPT_LIB / PYTHONPATH as "
                "described in Resolve's Developer/Scripting/README.txt, or run this script from Workspace > Scripts."
            ) from err
    obj = dvr.scriptapp("Resolve")
    if not obj:
        raise SystemExit("Could not connect to DaVinci Resolve. Is it running, and is external scripting enabled "
                         "(Preferences > System > General > External scripting using)?")
    return obj


# ----------------------------------------------------------------- pure helpers (self-testable)

def norm_key(value) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def match_entry(mapping: dict, wanted) -> tuple[str, str] | None:
    """Find (description, id) in a Resolve {description: id} map, loosely."""
    if not mapping or wanted is None:
        return None
    target = norm_key(wanted)
    if not target:
        return None
    for desc, ident in mapping.items():
        if norm_key(ident) == target or norm_key(desc) == target:
            return desc, ident
    for desc, ident in mapping.items():
        if target in norm_key(desc):
            return desc, ident
    return None


def sanitize(name: str) -> str:
    cleaned = UNSAFE.sub("_", str(name or ""))
    cleaned = re.sub(r"\s+", " ", cleaned).strip().lstrip(".")
    return cleaned


def render_name(template: str, ctx: dict, now: _dt.datetime | None = None, underscore_spaces: bool = False) -> str:
    now = now or _dt.datetime.now()
    values = {"yymmdd": now.strftime("%y%m%d"), "date": now.strftime("%Y%m%d"), "yyyymmdd": now.strftime("%Y%m%d"),
              "time": now.strftime("%H%M%S"), **ctx}

    def repl(m):
        v = values.get(m.group(1))
        return "" if v is None else str(v)

    out = re.sub(r"\{(\w+)\}", repl, template or "")
    out = sanitize(out)
    if underscore_spaces:
        out = re.sub(r"\s+", "_", out)
    out = re.sub(r"_{2,}", "_", out).strip("_")
    return out or "export"


def default_label(name: str) -> str:
    first = (str(name or "").strip().split() or ["Export"])[0]
    clean = re.sub(r"[^A-Za-z0-9]", "", first)
    return (clean[0].upper() + clean[1:]) if clean else "Export"


def ensure_unique_token(template: str, target: str) -> str:
    t = template or DEFAULT_TEMPLATE
    if target in ("cuts", "stills") and not re.search(r"\{(cut|still|n|tc|in)\}", t):
        return t + "_{n}"
    return t


# --- timecode -------------------------------------------------------------

FRACTIONAL = {23.976: 24000 / 1001, 23.98: 24000 / 1001, 29.97: 30000 / 1001, 47.952: 48000 / 1001,
              59.94: 60000 / 1001, 119.88: 120000 / 1001}


def parse_fps(value) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 24.0
    if n <= 0:
        return 24.0
    return FRACTIONAL.get(n, n)


def tc_to_frames(tc: str, fps: float, drop: bool | None = None) -> int:
    parts = re.split(r"[:;,.]", str(tc).strip())
    if len(parts) != 4:
        raise ValueError(f"Bad timecode {tc!r}")
    h, m, s, f = (int(p) for p in parts)
    tb = max(1, round(fps))
    if drop is None:
        drop = ";" in str(tc) or "," in str(tc)
    frames = (h * 3600 + m * 60 + s) * tb + f
    if drop and tb in (30, 60):
        d = 2 if tb == 30 else 4
        total_minutes = h * 60 + m
        frames -= d * (total_minutes - total_minutes // 10)
    return frames


def frames_to_tc(frames: int, fps: float, drop: bool = False) -> str:
    tb = max(1, round(fps))
    n = max(0, int(round(frames)))
    sep = ":"
    if drop and tb in (30, 60):
        d = 2 if tb == 30 else 4
        per10 = round(fps * 600)
        per_min = tb * 60 - d
        tens, rem = divmod(n, per10)
        n += d * 9 * tens
        if rem > d:
            n += d * ((rem - d) // per_min)
        sep = ";"
    f = n % tb
    s = (n // tb) % 60
    m = (n // (tb * 60)) % 60
    h = (n // (tb * 3600)) % 24
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{f:02d}"


def tc_for_filename(tc: str) -> str:
    return re.sub(r"[:;,]", ".", str(tc))


def duration_label(frames: int, fps: float) -> str:
    seconds = max(0, frames) / (fps or 24)
    if seconds >= 60:
        return f"{int(seconds // 60)}m {seconds % 60:.1f}s"
    return f"{seconds:.1f}s"


# --- marks ---------------------------------------------------------------

def marks_from_markers(markers: dict, start_frame: int, fps: float, drop: bool = False) -> list[dict]:
    out = []
    for key, mk in (markers or {}).items():
        cd = str((mk or {}).get("customData") or "")
        kind = "cut" if cd.startswith("exportx:cut") else "still" if cd.startswith("exportx:still") else None
        if kind is None:
            continue
        rel_in = int(key)
        duration = max(1, int(mk.get("duration") or 1))
        rel_out = rel_in if kind == "still" else rel_in + duration - 1
        abs_in, abs_out = start_frame + rel_in, start_frame + rel_out
        out.append({
            "kind": kind, "relIn": rel_in, "relOut": rel_out, "absIn": abs_in, "absOut": abs_out,
            "durationFrames": rel_out - rel_in + 1,
            "tcIn": frames_to_tc(abs_in, fps, drop), "tcOut": frames_to_tc(abs_out, fps, drop),
            "duration": duration_label(rel_out - rel_in + 1, fps), "name": mk.get("name") or "",
        })
    out.sort(key=lambda m: (m["relIn"], m["kind"]))
    counts = {"cut": 0, "still": 0}
    for m in out:
        counts[m["kind"]] += 1
        m["index"] = counts[m["kind"]]
    return out


# --- profiles -------------------------------------------------------------

def normalize_profile(p: dict, source: str = "profile") -> dict:
    missing = [k for k in ("id", "name", "format", "codec") if not p.get(k)]
    if missing:
        raise ValueError(f"Invalid profile in {source}: missing {', '.join(missing)}")
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9_-]*$", str(p["id"])):
        raise ValueError(f"Invalid profile in {source}: bad id {p['id']!r}")
    target = p.get("target") or "timeline"
    if target not in TARGETS:
        raise ValueError(f"Invalid profile in {source}: target must be one of {', '.join(TARGETS)}")
    sub = str(p.get("subfolder") or "")
    if os.path.isabs(sub) or re.search(r"(^|[\\/])\.\.([\\/]|$)", sub):
        raise ValueError(f"Invalid profile in {source}: subfolder must be relative and may not contain '..'")
    res = p.get("resolution")
    if res is not None and not (isinstance(res.get("width"), int) and isinstance(res.get("height"), int)):
        raise ValueError(f"Invalid profile in {source}: resolution must be {{width:int, height:int}}")
    label = str(p.get("label") or default_label(p["name"]))
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9_-]*$", label):
        raise ValueError(f"Invalid profile in {source}: bad label {label!r}")
    return {
        "id": str(p["id"]),
        "name": str(p["name"]),
        "label": label,
        "description": str(p.get("description") or ""),
        "target": target,
        "renderPreset": p.get("renderPreset") or None,
        "format": str(p["format"]),
        "codec": str(p["codec"]),
        "renderMode": p.get("renderMode") or "single",
        "resolution": res,
        "frameRate": p.get("frameRate"),
        "settings": dict(p.get("settings") or {}),
        "subfolder": sub,
        "fileSuffix": str(p.get("fileSuffix") or ""),
        "enabledByDefault": p.get("enabledByDefault", True) is not False,
        "tags": list(p.get("tags") or []),
    }


def load_profiles(dirs) -> list[dict]:
    by_id: dict[str, dict] = {}
    for d in dirs:
        d = Path(d).expanduser()
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.json")):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except json.JSONDecodeError as err:
                print(f"warning: skipping {f}: {err}", file=sys.stderr)
                continue
            if isinstance(data, list):
                items = data
            elif isinstance(data, dict) and isinstance(data.get("profiles"), list):
                items = data["profiles"]
            else:
                items = [data]
            for i, item in enumerate(items):
                try:
                    prof = normalize_profile(item, f"{f}[{i}]")
                except ValueError as err:
                    print(f"warning: {err}", file=sys.stderr)
                    continue
                prof["source"] = str(f)
                by_id[prof["id"]] = prof
    return list(by_id.values())


def default_profile_dirs() -> list[str]:
    here = Path(__file__).resolve().parent
    home = Path(os.environ.get("EXPORTX_HOME") or Path.home() / ".exportx")
    dirs = [str(here.parent / "profiles"), str(here / "profiles"), str(home / "profiles")]
    extra = os.environ.get("EXPORTX_PROFILE_DIRS")
    if extra:
        dirs.extend(extra.split(os.pathsep))
    return dirs


def build_render_settings(profile: dict, target_dir: str, custom_name: str, rng: tuple[int, int] | None = None) -> dict:
    s = dict(profile.get("settings") or {})
    s["TargetDir"] = target_dir
    s["CustomName"] = custom_name
    if profile.get("resolution"):
        s["FormatWidth"] = int(profile["resolution"]["width"])
        s["FormatHeight"] = int(profile["resolution"]["height"])
    if profile.get("frameRate") is not None:
        s["FrameRate"] = profile["frameRate"]
    if rng:
        s["SelectAllFrames"] = False
        s["MarkIn"], s["MarkOut"] = int(rng[0]), int(rng[1])
    else:
        s.setdefault("SelectAllFrames", True)
    s.setdefault("ExportVideo", True)
    if profile.get("target") == "stills":
        s["ExportAudio"] = False
    else:
        s.setdefault("ExportAudio", True)
    return s


def expand_items(profiles, targets, timeline_name, project_name, marks, template, out_dir, now=None, underscore_spaces=False):
    """Pure expansion of one timeline into job items; mirrors src/batch.js expandItems()."""
    items, notes = [], []
    for prof in profiles:
        target = prof.get("target") or "timeline"
        if target not in targets:
            continue
        target_dir = os.path.join(out_dir, prof["subfolder"]) if prof["subfolder"] else out_dir
        ctx = {
            "project": project_name, "timeline": timeline_name, "profile": prof["id"], "profileName": prof["name"],
            "label": prof.get("label") or default_label(prof["name"]),
            "format": prof["format"], "codec": prof["codec"],
            "width": (prof.get("resolution") or {}).get("width", ""),
            "height": (prof.get("resolution") or {}).get("height", ""),
        }
        if target == "timeline":
            items.append({"profile": prof, "timeline": timeline_name, "kind": "final", "targetDir": target_dir,
                          "fileName": render_name(template or DEFAULT_TEMPLATE, ctx, now, underscore_spaces) + prof["fileSuffix"], "range": None, "mark": None})
            continue
        kind = "cut" if target == "cuts" else "still"
        chosen = [m for m in marks if m["kind"] == kind]
        if not chosen:
            notes.append({"profile": prof["id"], "profileName": prof["name"], "timeline": timeline_name,
                          "message": f"No {kind}s marked on '{timeline_name}'"})
            continue
        tpl = ensure_unique_token(template, target)
        for m in chosen:
            n = f"{m['index']:02d}"
            name = render_name(tpl, {**ctx, "cut": n, "still": n, "n": n, "tc": tc_for_filename(m["tcIn"]),
                                     "tcout": tc_for_filename(m["tcOut"]), "in": m["absIn"], "out": m["absOut"]}, now, underscore_spaces)
            items.append({"profile": prof, "timeline": timeline_name, "kind": kind, "targetDir": target_dir,
                          "fileName": name + prof["fileSuffix"], "range": (m["absIn"], m["absOut"]), "mark": m})
    return items, notes


def normalize_status(raw: dict) -> dict:
    raw = raw or {}
    text = str(raw.get("JobStatus") or raw.get("Status") or "").lower()
    status = {"ready": "ready", "rendering": "rendering", "complete": "complete", "completed": "complete",
              "failed": "failed", "cancelled": "cancelled", "canceled": "cancelled"}.get(text, text or "unknown")
    return {"status": status, "percent": int(raw.get("CompletionPercentage") or 0), "error": raw.get("Error")}


# ----------------------------------------------------------------- Resolve operations

def get_project(resolve):
    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject() if pm else None
    if not project:
        raise SystemExit("No project is open in Resolve.")
    return project


def list_timelines(project) -> tuple[str | None, list]:
    current = project.GetCurrentTimeline()
    current_name = current.GetName() if current else None
    names = []
    for i in range(1, int(project.GetTimelineCount() or 0) + 1):
        tl = project.GetTimelineByIndex(i)
        if tl:
            names.append(tl.GetName())
    return current_name, names


def timeline_by_name(project, name: str):
    for i in range(1, int(project.GetTimelineCount() or 0) + 1):
        tl = project.GetTimelineByIndex(i)
        if tl and tl.GetName() == name:
            return tl
    raise RuntimeError(f"Timeline {name!r} not found")


def timeline_info(tl) -> dict:
    fps = parse_fps(tl.GetSetting("timelineFrameRate"))
    try:
        drop = str(tl.GetSetting("timelineDropFrameTimecode")) == "1"
    except Exception:  # noqa: BLE001
        drop = False
    start = int(tl.GetStartFrame() or 0)
    return {"name": tl.GetName(), "startFrame": start, "endFrame": int(tl.GetEndFrame() or start), "fps": fps, "drop": drop}


def timeline_marks(tl) -> tuple[dict, list[dict]]:
    info = timeline_info(tl)
    return info, marks_from_markers(tl.GetMarkers() or {}, info["startFrame"], info["fps"], info["drop"])


def add_mark(tl, kind: str, tc_in: str, tc_out: str | None = None) -> dict:
    info, marks = timeline_marks(tl)
    abs_in = tc_to_frames(tc_in, info["fps"])
    abs_out = tc_to_frames(tc_out, info["fps"]) if tc_out else abs_in
    abs_in, abs_out = min(abs_in, abs_out), max(abs_in, abs_out)
    rel_in = max(0, abs_in - info["startFrame"])
    duration = 1 if kind == "still" else abs_out - abs_in + 1
    n = sum(1 for m in marks if m["kind"] == kind) + 1
    spec = MARK_KINDS[kind]
    if not tl.AddMarker(rel_in, spec["color"], f"{spec['label']} {n}", "Marked with ExportX", duration, spec["customData"]):
        raise RuntimeError(f"Resolve refused a marker at {frames_to_tc(abs_in, info['fps'], info['drop'])} (already a marker there?)")
    return {"kind": kind, "index": n, "tcIn": frames_to_tc(abs_in, info["fps"], info["drop"]),
            "tcOut": frames_to_tc(abs_out, info["fps"], info["drop"])}


def apply_profile(project, profile: dict, target_dir: str, custom_name: str, rng=None) -> dict:
    if profile.get("renderPreset") and not project.LoadRenderPreset(profile["renderPreset"]):
        raise RuntimeError(f"Render preset {profile['renderPreset']!r} could not be loaded")
    fmt = match_entry(project.GetRenderFormats() or {}, profile["format"])
    if not fmt:
        raise RuntimeError(f"Unknown render format {profile['format']!r}")
    codecs = project.GetRenderCodecs(fmt[1]) or {}
    if AUTO_CODEC.match(profile["codec"]):
        codec = next(iter(codecs.items()), None)
        codec = (codec[0], codec[1]) if codec else None
    else:
        codec = match_entry(codecs, profile["codec"])
    if not codec:
        raise RuntimeError(f"Unknown codec {profile['codec']!r} for format {fmt[1]}")
    if not project.SetCurrentRenderFormatAndCodec(fmt[1], codec[1]):
        raise RuntimeError(f"Resolve rejected format/codec {fmt[1]}/{codec[1]}")
    project.SetCurrentRenderMode(0 if profile.get("renderMode") == "individual" else 1)
    settings = build_render_settings(profile, target_dir, custom_name, rng)
    if not project.SetRenderSettings(settings):
        raise RuntimeError(f"Resolve rejected render settings for {profile['id']}: {settings}")
    return settings


def queue_jobs(project, profiles, targets, out_dir: str, template: str, timelines=None, clear_queue=False, log=print, underscore_spaces=True):
    project_name = project.GetName()
    current_name, all_names = list_timelines(project)
    wanted = list(timelines) if timelines else ([current_name] if current_name else [])
    if not wanted:
        raise SystemExit("No timeline is open; pass --timeline or open one in Resolve.")
    unknown = [t for t in wanted if t not in all_names]
    if unknown:
        raise SystemExit(f"Unknown timeline(s): {', '.join(unknown)}")
    if clear_queue:
        project.DeleteAllRenderJobs()
        log("Cleared existing render queue")

    needs_marks = any((p.get("target") or "timeline") != "timeline" and (p.get("target") in targets) for p in profiles)
    jobs, errors, notes = [], [], []
    active = current_name
    try:
        for tl_name in wanted:
            tl = timeline_by_name(project, tl_name)
            marks = timeline_marks(tl)[1] if needs_marks else []
            items, tl_notes = expand_items(profiles, targets, tl_name, project_name, marks, template, out_dir, None, underscore_spaces)
            notes.extend(tl_notes)
            for n in tl_notes:
                log(f"{n['profileName']}: {n['message']}")
            if not items:
                continue
            if tl_name != active:
                if not project.SetCurrentTimeline(tl):
                    raise RuntimeError(f"Resolve refused to switch to timeline {tl_name!r}")
                active = tl_name
            for it in items:
                prof = it["profile"]
                try:
                    os.makedirs(it["targetDir"], exist_ok=True)
                    apply_profile(project, prof, it["targetDir"], it["fileName"], it["range"])
                    job_id = project.AddRenderJob()
                    if not job_id:
                        raise RuntimeError("AddRenderJob returned nothing")
                    jobs.append({"jobId": job_id, "timeline": tl_name, "profile": prof["id"], "kind": it["kind"],
                                 "targetDir": it["targetDir"], "fileName": it["fileName"]})
                    where = f" [{it['mark']['tcIn']}{' -> ' + it['mark']['tcOut'] if it['kind'] == 'cut' else ''}]" if it["mark"] else ""
                    log(f"Queued {prof['name']} for '{tl_name}'{where} -> {os.path.join(it['targetDir'], it['fileName'])}")
                except Exception as err:  # noqa: BLE001 - keep going with the other items
                    errors.append({"timeline": tl_name, "profile": prof["id"], "fileName": it["fileName"], "message": str(err)})
                    log(f"Skipped {prof['name']} ({it['fileName']}): {err}")
    finally:
        if current_name and active != current_name:
            try:
                project.SetCurrentTimeline(timeline_by_name(project, current_name))
            except Exception as err:  # noqa: BLE001
                log(f"Could not switch back to '{current_name}': {err}")
    return jobs, errors, notes


def wait_for_jobs(project, job_ids, interval=2.0, log=print):
    idle = 0
    last_line = ""
    while True:
        statuses = {jid: normalize_status(project.GetRenderJobStatus(jid)) for jid in job_ids}
        done = sum(1 for s in statuses.values() if s["status"] == "complete")
        failed = sum(1 for s in statuses.values() if s["status"] in ("failed", "cancelled"))
        pct = round(sum(100 if s["status"] == "complete" else s["percent"] for s in statuses.values()) / max(1, len(statuses)))
        line = f"{pct}%  {done} done, {failed} failed/cancelled, {len(statuses) - done - failed} pending"
        if line != last_line:
            log(line)
            last_line = line
        if all(s["status"] in TERMINAL for s in statuses.values()):
            return statuses
        idle = 0 if project.IsRenderingInProgress() else idle + 1
        if idle >= 3:
            log("Resolve is no longer rendering; stopping the wait.")
            return statuses
        time.sleep(interval)


# ----------------------------------------------------------------- CLI

def parse_args(argv):
    p = argparse.ArgumentParser(description="ExportX batch exporter for DaVinci Resolve")
    p.add_argument("--out", default=os.environ.get("EXPORTX_OUT") or CONFIG["out"], help="output folder")
    p.add_argument("-p", "--profile", action="append", dest="profiles", help="profile id (repeatable)")
    p.add_argument("--all", action="store_true", help="use every known profile")
    p.add_argument("--targets", default=os.environ.get("EXPORTX_TARGETS") or ",".join(CONFIG["targets"]),
                   help="comma-separated subset of timeline,cuts,stills (default: all)")
    p.add_argument("--profiles-dir", action="append", default=[], help="extra profile directory (repeatable)")
    p.add_argument("-t", "--timeline", action="append", dest="timelines", help="timeline name (repeatable)")
    p.add_argument("--all-timelines", action="store_true", help="queue every timeline in the project")
    p.add_argument("--name", default=os.environ.get("EXPORTX_TEMPLATE") or CONFIG["template"], help="filename template (default {yymmdd}_{project}_{label})")
    p.add_argument("--keep-spaces", action="store_true", help="keep spaces in file names instead of turning them into underscores")
    p.add_argument("--render", action="store_true", help="start rendering after queuing")
    p.add_argument("--wait", action="store_true", help="wait for rendering to finish (implies --render)")
    p.add_argument("--clear-queue", action="store_true", help="delete existing render jobs first")
    p.add_argument("--mark-cut", nargs=2, action="append", metavar=("IN", "OUT"), default=[], help="add a cut marker (timecodes)")
    p.add_argument("--mark-still", action="append", metavar="TC", default=[], help="add a still marker (timecode)")
    p.add_argument("--clear-marks", choices=["cut", "still", "all"], help="remove ExportX markers from the current timeline")
    p.add_argument("--list", action="store_true", help="list timelines, marks, profiles, presets, formats and codecs, then exit")
    p.add_argument("--selftest", action="store_true", help="run offline self-tests (no Resolve needed)")
    args, _unknown = p.parse_known_args(argv)
    return args


def selftest() -> int:
    assert match_entry({"Apple ProRes 422 HQ": "ProRes422HQ", "H.264": "H264"}, "prores 422 hq") == ("Apple ProRes 422 HQ", "ProRes422HQ")
    assert match_entry({"H.264": "H264"}, "h264") == ("H.264", "H264")
    assert match_entry({"H.264": "H264"}, "av1") is None
    fixed = _dt.datetime(2026, 10, 17, 14, 5, 9)
    assert render_name("{timeline}_{profile}_{date}", {"timeline": "Main Edit", "profile": "h264-web"}, fixed) == "Main Edit_h264-web_20261017"
    assert render_name(DEFAULT_TEMPLATE, {"project": "Spot A", "label": "Final"}, fixed, True) == "261017_Spot_A_Final"
    assert default_label("Social cuts 9:16") == "Social"
    assert render_name("{timeline}:{nope}", {"timeline": "A/B"}, fixed) == "A_B"
    assert render_name("{nope}", {}, fixed) == "export"
    assert tc_to_frames("01:00:12:05", 24) == 86400 + 12 * 24 + 5
    assert frames_to_tc(86400 + 12 * 24 + 5, 24) == "01:00:12:05"
    assert tc_to_frames("00:01:00;02", 29.97) == 1800 and frames_to_tc(1800, 29.97, True) == "00:01:00;02"
    assert tc_to_frames("00:10:00;00", 29.97) == 17982 and frames_to_tc(17982, 29.97, True) == "00:10:00;00"
    markers = {"24": {"color": "Cyan", "duration": 48, "customData": "exportx:cut"},
               "100": {"color": "Pink", "duration": 1, "customData": "exportx:still"},
               "400": {"color": "Blue", "duration": 1, "customData": ""}}
    marks = marks_from_markers(markers, 86400, 24)
    assert [(m["kind"], m["index"], m["absIn"], m["absOut"]) for m in marks] == [("cut", 1, 86424, 86471), ("still", 1, 86500, 86500)]
    assert marks[0]["tcIn"] == "01:00:01:00" and marks[0]["tcOut"] == "01:00:02:23"
    profs = load_profiles(default_profile_dirs())
    ids = {p["id"] for p in profs}
    assert {"final-prores-master", "cuts-social-1080", "stills-tiff"} <= ids, "bundled profiles not found"
    by_id = {p["id"]: p for p in profs}
    items, notes = expand_items([by_id["final-4k-h265"], by_id["cuts-social-1080"], by_id["stills-tiff"]], TARGETS,
                                "Main Edit", "P", marks, DEFAULT_TEMPLATE, "/out", fixed)
    assert [i["fileName"] for i in items] == ["261017_P_Final", "261017_P_Social_01", "261017_P_Still_01"], [i["fileName"] for i in items]
    assert items[1]["range"] == (86424, 86471) and items[2]["range"] == (86500, 86500)
    still_settings = build_render_settings(by_id["stills-tiff"], "/out", "x", items[2]["range"])
    assert still_settings["ExportAudio"] is False and still_settings["MarkIn"] == still_settings["MarkOut"] == 86500
    s = build_render_settings(by_id["final-1080-h264"], "/out", "name")
    assert s["FormatWidth"] == 1920 and s["TargetDir"] == "/out" and s["CustomName"] == "name"
    _, only_notes = expand_items([by_id["cuts-social-1080"]], TARGETS, "TL", "P", [], DEFAULT_TEMPLATE, "/out", fixed)
    assert only_notes and "No cuts marked" in only_notes[0]["message"]
    try:
        normalize_profile({"id": "x", "name": "X", "format": "mp4", "codec": "H264", "subfolder": "../up"})
    except ValueError:
        pass
    else:
        raise AssertionError("subfolder escape should be rejected")
    print("selftest ok")
    return 0


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    args = parse_args(argv)
    if args.selftest:
        return selftest()

    profiles = load_profiles(default_profile_dirs() + list(args.profiles_dir))
    if not profiles:
        raise SystemExit("No profiles found. See docs/PROFILES.md.")

    resolve = get_resolve()
    project = get_project(resolve)

    if args.mark_cut or args.mark_still or args.clear_marks:
        tl = project.GetCurrentTimeline()
        if not tl:
            raise SystemExit("No timeline is open.")
        if args.clear_marks:
            _, marks = timeline_marks(tl)
            for m in marks:
                if args.clear_marks == "all" or m["kind"] == args.clear_marks:
                    tl.DeleteMarkerAtFrame(m["relIn"])
            print(f"Cleared {args.clear_marks} marks.")
        for tc_in, tc_out in args.mark_cut:
            m = add_mark(tl, "cut", tc_in, tc_out)
            print(f"Marked cut {m['index']}: {m['tcIn']} -> {m['tcOut']}")
        for tc in args.mark_still:
            m = add_mark(tl, "still", tc)
            print(f"Marked still {m['index']}: {m['tcIn']}")
        if not (args.out or args.list):
            return 0

    if args.list:
        current, names = list_timelines(project)
        print(f"Project: {project.GetName()}")
        print("Timelines: " + ", ".join(f"{n}{' (current)' if n == current else ''}" for n in names))
        tl = project.GetCurrentTimeline()
        if tl:
            info, marks = timeline_marks(tl)
            print(f"\nMarks on '{info['name']}' ({info['fps']:g} fps):")
            for m in marks:
                rng = f"{m['tcIn']} -> {m['tcOut']} ({m['duration']})" if m["kind"] == "cut" else m["tcIn"]
                print(f"  {m['kind']:<5} {m['index']:>2}  {rng}")
            if not marks:
                print("  (none)")
        print("\nProfiles:")
        for p in profiles:
            res = f" {p['resolution']['width']}x{p['resolution']['height']}" if p.get("resolution") else ""
            print(f"  {p['id']:<24} {p['target']:<9} {p['format']}/{p['codec']}{res}  - {p['name']}")
        print("\nRender presets: " + ", ".join(project.GetRenderPresetList() or []))
        print("\nFormats and codecs:")
        for desc, fid in (project.GetRenderFormats() or {}).items():
            codecs = project.GetRenderCodecs(fid) or {}
            print(f"  {fid:<12} ({desc}): " + ", ".join(f"{cid} [{cdesc}]" for cdesc, cid in codecs.items()))
        return 0

    wanted = args.profiles or [s for s in (os.environ.get("EXPORTX_PROFILES") or "").split(",") if s] or CONFIG["profiles"]
    if args.all:
        chosen = profiles
    elif wanted:
        by_id = {p["id"]: p for p in profiles}
        missing = [w for w in wanted if w not in by_id]
        if missing:
            raise SystemExit(f"Unknown profile(s): {', '.join(missing)}. Run with --list.")
        chosen = [by_id[w] for w in wanted]
    else:
        chosen = [p for p in profiles if p["enabledByDefault"]]

    targets = [t.strip() for t in (args.targets or "").split(",") if t.strip()] or list(TARGETS)
    bad = [t for t in targets if t not in TARGETS]
    if bad:
        raise SystemExit(f"Unknown target(s): {', '.join(bad)}. Use timeline, cuts, stills.")

    out_dir = os.path.expanduser(args.out or "")
    if not out_dir:
        raise SystemExit("No output folder. Pass --out, set EXPORTX_OUT, or edit CONFIG in the script.")

    timelines = args.timelines
    if args.all_timelines:
        timelines = list_timelines(project)[1]

    jobs, errors, notes = queue_jobs(project, chosen, targets, out_dir, args.name, timelines, args.clear_queue,
                                     underscore_spaces=not args.keep_spaces and CONFIG["underscore_spaces"])
    print(f"\nQueued {len(jobs)} job(s); {len(errors)} skipped; {len(notes)} note(s).")
    if not jobs:
        return 1

    should_render = args.render or args.wait or os.environ.get("EXPORTX_RENDER") == "1" or (not argv and CONFIG["render"])
    if should_render:
        ids = [j["jobId"] for j in jobs]
        if not project.StartRendering(ids, False):
            raise SystemExit("Resolve refused to start rendering (is a render already running?)")
        print("Rendering started.")
        if args.wait or (not argv and CONFIG["wait"]):
            statuses = wait_for_jobs(project, ids)
            failed = [jid for jid, s in statuses.items() if s["status"] != "complete"]
            if failed:
                for jid in failed:
                    print(f"  {jid}: {statuses[jid]['status']} {statuses[jid].get('error') or ''}")
                return 2
            print("All renders complete.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
