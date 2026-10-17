#!/usr/bin/env python3
"""
ExportX batch exporter, Python edition.

Queues one Resolve render job per (timeline x deliverable profile) and can
start the render and wait for it. Uses the same JSON profiles as the ExportX
Workflow Integration plugin (see ../profiles and docs/PROFILES.md).

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
     python3 exportx_batch.py --all --out "/Volumes/Deliver/Job123" --render --wait
     python3 exportx_batch.py -p prores-master -p h264-web --out ~/Exports --timeline "Main Edit"

Environment variables honoured in both modes:
   EXPORTX_OUT        output folder
   EXPORTX_PROFILES   comma-separated profile ids (default: profiles with enabledByDefault)
   EXPORTX_PROFILE_DIRS  os.pathsep-separated extra profile directories
   EXPORTX_TEMPLATE   filename template (default {timeline}_{profile})
   EXPORTX_RENDER     "1" to start rendering after queuing
   EXPORTX_HOME       overrides ~/.exportx
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
    "profiles": [],                   # e.g. ["prores-master", "h264-web"]; [] = enabledByDefault ones
    "template": "{timeline}_{profile}",
    "render": True,
    "wait": True,
    "clear_queue": False,
}

DEFAULT_TEMPLATE = "{timeline}_{profile}"
TERMINAL = {"complete", "failed", "cancelled"}
UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


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


def render_name(template: str, ctx: dict, now: _dt.datetime | None = None) -> str:
    now = now or _dt.datetime.now()
    values = {"date": now.strftime("%Y%m%d"), "time": now.strftime("%H%M%S"), **ctx}

    def repl(m):
        v = values.get(m.group(1))
        return "" if v is None else str(v)

    out = re.sub(r"\{(\w+)\}", repl, template or "")
    out = sanitize(out)
    out = re.sub(r"_{2,}", "_", out).strip("_")
    return out or "export"


def normalize_profile(p: dict, source: str = "profile") -> dict:
    missing = [k for k in ("id", "name", "format", "codec") if not p.get(k)]
    if missing:
        raise ValueError(f"Invalid profile in {source}: missing {', '.join(missing)}")
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9_-]*$", str(p["id"])):
        raise ValueError(f"Invalid profile in {source}: bad id {p['id']!r}")
    sub = str(p.get("subfolder") or "")
    if os.path.isabs(sub) or re.search(r"(^|[\\/])\.\.([\\/]|$)", sub):
        raise ValueError(f"Invalid profile in {source}: subfolder must be relative and may not contain '..'")
    res = p.get("resolution")
    if res is not None and not (isinstance(res.get("width"), int) and isinstance(res.get("height"), int)):
        raise ValueError(f"Invalid profile in {source}: resolution must be {{width:int, height:int}}")
    return {
        "id": str(p["id"]),
        "name": str(p["name"]),
        "description": str(p.get("description") or ""),
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


def build_render_settings(profile: dict, target_dir: str, custom_name: str) -> dict:
    s = dict(profile.get("settings") or {})
    s["TargetDir"] = target_dir
    s["CustomName"] = custom_name
    if profile.get("resolution"):
        s["FormatWidth"] = int(profile["resolution"]["width"])
        s["FormatHeight"] = int(profile["resolution"]["height"])
    if profile.get("frameRate") is not None:
        s["FrameRate"] = profile["frameRate"]
    s.setdefault("SelectAllFrames", True)
    s.setdefault("ExportVideo", True)
    s.setdefault("ExportAudio", True)
    return s


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


def set_timeline(project, name: str) -> None:
    for i in range(1, int(project.GetTimelineCount() or 0) + 1):
        tl = project.GetTimelineByIndex(i)
        if tl and tl.GetName() == name:
            if not project.SetCurrentTimeline(tl):
                raise RuntimeError(f"Resolve refused to switch to timeline {name!r}")
            return
    raise RuntimeError(f"Timeline {name!r} not found")


def apply_profile(project, profile: dict, target_dir: str, custom_name: str) -> dict:
    if profile.get("renderPreset") and not project.LoadRenderPreset(profile["renderPreset"]):
        raise RuntimeError(f"Render preset {profile['renderPreset']!r} could not be loaded")
    fmt = match_entry(project.GetRenderFormats() or {}, profile["format"])
    if not fmt:
        raise RuntimeError(f"Unknown render format {profile['format']!r}")
    codec = match_entry(project.GetRenderCodecs(fmt[1]) or {}, profile["codec"])
    if not codec:
        raise RuntimeError(f"Unknown codec {profile['codec']!r} for format {fmt[1]}")
    if not project.SetCurrentRenderFormatAndCodec(fmt[1], codec[1]):
        raise RuntimeError(f"Resolve rejected format/codec {fmt[1]}/{codec[1]}")
    project.SetCurrentRenderMode(0 if profile.get("renderMode") == "individual" else 1)
    settings = build_render_settings(profile, target_dir, custom_name)
    if not project.SetRenderSettings(settings):
        raise RuntimeError(f"Resolve rejected render settings for {profile['id']}: {settings}")
    return settings


def queue_jobs(project, profiles, out_dir: str, template: str, timelines=None, clear_queue=False, log=print):
    project_name = project.GetName()
    current_name, all_names = list_timelines(project)
    targets = list(timelines) if timelines else ([current_name] if current_name else [])
    if not targets:
        raise SystemExit("No timeline is open; pass --timeline or open one in Resolve.")
    unknown = [t for t in targets if t not in all_names]
    if unknown:
        raise SystemExit(f"Unknown timeline(s): {', '.join(unknown)}")
    if clear_queue:
        project.DeleteAllRenderJobs()
        log("Cleared existing render queue")

    jobs, errors = [], []
    active = current_name
    try:
        for tl_name in targets:
            if tl_name != active:
                set_timeline(project, tl_name)
                active = tl_name
            for prof in profiles:
                target_dir = os.path.join(out_dir, prof["subfolder"]) if prof["subfolder"] else out_dir
                base = render_name(template, {
                    "project": project_name, "timeline": tl_name, "profile": prof["id"],
                    "profileName": prof["name"], "format": prof["format"], "codec": prof["codec"],
                    "width": (prof.get("resolution") or {}).get("width", ""),
                    "height": (prof.get("resolution") or {}).get("height", ""),
                })
                file_name = base + prof["fileSuffix"]
                try:
                    os.makedirs(target_dir, exist_ok=True)
                    apply_profile(project, prof, target_dir, file_name)
                    job_id = project.AddRenderJob()
                    if not job_id:
                        raise RuntimeError("AddRenderJob returned nothing")
                    jobs.append({"jobId": job_id, "timeline": tl_name, "profile": prof["id"],
                                 "targetDir": target_dir, "fileName": file_name})
                    log(f"Queued {prof['name']} for '{tl_name}' -> {os.path.join(target_dir, file_name)}")
                except Exception as err:  # noqa: BLE001 - keep going with the other profiles
                    errors.append({"timeline": tl_name, "profile": prof["id"], "message": str(err)})
                    log(f"Skipped {prof['name']} for '{tl_name}': {err}")
    finally:
        if current_name and active != current_name:
            try:
                set_timeline(project, current_name)
            except Exception as err:  # noqa: BLE001
                log(f"Could not switch back to '{current_name}': {err}")
    return jobs, errors


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
    p.add_argument("--profiles-dir", action="append", default=[], help="extra profile directory (repeatable)")
    p.add_argument("-t", "--timeline", action="append", dest="timelines", help="timeline name (repeatable)")
    p.add_argument("--all-timelines", action="store_true", help="queue every timeline in the project")
    p.add_argument("--name", default=os.environ.get("EXPORTX_TEMPLATE") or CONFIG["template"], help="filename template")
    p.add_argument("--render", action="store_true", help="start rendering after queuing")
    p.add_argument("--wait", action="store_true", help="wait for rendering to finish (implies --render)")
    p.add_argument("--clear-queue", action="store_true", help="delete existing render jobs first")
    p.add_argument("--list", action="store_true", help="list profiles, presets, formats and codecs, then exit")
    p.add_argument("--selftest", action="store_true", help="run offline self-tests (no Resolve needed)")
    args, _unknown = p.parse_known_args(argv)
    return args


def selftest() -> int:
    assert match_entry({"Apple ProRes 422 HQ": "ProRes422HQ", "H.264": "H264"}, "prores 422 hq") == ("Apple ProRes 422 HQ", "ProRes422HQ")
    assert match_entry({"H.264": "H264"}, "h264") == ("H.264", "H264")
    assert match_entry({"H.264": "H264"}, "av1") is None
    fixed = _dt.datetime(2026, 10, 17, 14, 5, 9)
    assert render_name("{timeline}_{profile}_{date}", {"timeline": "Main Edit", "profile": "h264-web"}, fixed) == "Main Edit_h264-web_20261017"
    assert render_name("{timeline}:{nope}", {"timeline": "A/B"}, fixed) == "A_B"
    assert render_name("{nope}", {}, fixed) == "export"
    profs = load_profiles(default_profile_dirs())
    assert any(p["id"] == "prores-master" for p in profs), "bundled profiles not found"
    s = build_render_settings(next(p for p in profs if p["id"] == "h264-web"), "/out", "name")
    assert s["FormatWidth"] == 1920 and s["TargetDir"] == "/out" and s["CustomName"] == "name"
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

    if args.list:
        current, names = list_timelines(project)
        print(f"Project: {project.GetName()}")
        print("Timelines: " + ", ".join(f"{n}{' (current)' if n == current else ''}" for n in names))
        print("\nProfiles:")
        for p in profiles:
            res = f" {p['resolution']['width']}x{p['resolution']['height']}" if p.get("resolution") else ""
            print(f"  {p['id']:<24} {p['format']}/{p['codec']}{res}  - {p['name']}")
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

    out_dir = os.path.expanduser(args.out or "")
    if not out_dir:
        raise SystemExit("No output folder. Pass --out, set EXPORTX_OUT, or edit CONFIG in the script.")

    timelines = args.timelines
    if args.all_timelines:
        timelines = list_timelines(project)[1]

    jobs, errors = queue_jobs(project, chosen, out_dir, args.name, timelines, args.clear_queue)
    print(f"\nQueued {len(jobs)} job(s); {len(errors)} skipped.")
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
