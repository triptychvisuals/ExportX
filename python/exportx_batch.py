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
   EXPORTX_WHOLE         "1" to ignore the In and Out set in Resolve and export whole timelines
   EXPORTX_HOME          overrides ~/.exportx
   EXPORTX_PORTAL_URL    Triptych Studios portal URL for --upload (see portal-kit/)
   EXPORTX_PORTAL_TOKEN  the plugin key from the portal (Settings > ExportX) for --upload
   EXPORTX_PORTAL_PROJECT  the portal project id the files go in (see --list-projects)
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
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
    "whole_timeline": False,          # True: ignore the In and Out set in Resolve and export each timeline whole
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


# ----------------------------------------------------------------- size estimates (mirrors src/estimate.js)

FIXED_BPP = [(r"prores.*4444.*xq", 8.05, "ProRes 4444 XQ"), (r"prores.*4444", 5.31, "ProRes 4444"),
             (r"prores.*422.*hq|proreshq|prores_hq", 3.54, "ProRes 422 HQ"), (r"prores.*422.*lt|proreslt", 1.64, "ProRes 422 LT"),
             (r"prores.*proxy", 0.72, "ProRes Proxy"), (r"prores", 2.37, "ProRes 422"),
             (r"dnxhr.*444", 5.6, "DNxHR 444"), (r"dnxhr.*hqx", 3.5, "DNxHR HQX"), (r"dnxhr.*hq", 2.8, "DNxHR HQ"),
             (r"dnxhr.*sq", 1.85, "DNxHR SQ"), (r"dnxhr.*lb", 0.58, "DNxHR LB"), (r"dnxhd", 2.9, "DNxHD"),
             (r"cineform", 2.5, "CineForm"), (r"uncompressed|v210|r210|rgb ?10|^yuv", 20, "uncompressed"),
             (r"mjpeg|motion ?jpeg|photo ?jpeg", 2.5, "Motion JPEG")]
AUTO_BPP = [(r"h\.?265|hevc", 0.25, "H.265"), (r"h\.?264|avc|x264", 0.4, "H.264"), (r"av1", 0.2, "AV1"),
            (r"vp9", 0.25, "VP9"), (r"mpeg|xdcam|imx", 0.5, "MPEG")]
IMAGE_BYTES = {"tif": ({8: 3, 16: 6}, True, "TIFF"), "tiff": ({8: 3, 16: 6}, True, "TIFF"), "dpx": ({8: 3, 10: 4, 16: 6}, True, "DPX"),
               "png": ({8: 1.6, 16: 3.5}, False, "PNG"), "jpg": ({8: 0.35}, False, "JPEG"), "jpeg": ({8: 0.35}, False, "JPEG"),
               "exr": ({16: 3, 32: 6}, False, "EXR"), "bmp": ({8: 3}, True, "BMP"), "tga": ({8: 3}, True, "TGA")}
LEVEL_SCALE = {"Least": 0.3, "Low": 0.5, "Medium": 0.72, "High": 1, "Best": 1.5}
COMPRESSED_AUDIO_KBPS = 320


def estimate_bytes(fmt, codec, settings, width, height, fps, frames, kind="final", channels=2) -> dict:
    """What a job will weigh, from its codec settings: a bit rate x seconds (close to exact), a fixed-rate codec's bits per
    pixel, a long-GOP codec's typical automatic rate, or a still's bytes per pixel. Mirrors estimateBytes() in src/estimate.js."""
    settings = settings or {}
    pixels = int(width or 0) * int(height or 0)
    frames = int(frames or 0)
    fmt = str(fmt or "").lower()
    codec = str(codec or "")
    if not pixels or not frames:
        return {"bytes": None, "exact": False, "basis": "unknown size or length"}
    seconds = frames / fps if fps else 0
    export_video = settings.get("ExportVideo") is not False
    export_audio = settings.get("ExportAudio") is not False and fmt not in IMAGE_BYTES and kind != "still"
    video_bits, exact = 0.0, True
    if not export_video:
        basis = "audio only"
    elif fmt in IMAGE_BYTES:
        table, exact, name = IMAGE_BYTES[fmt]
        if fmt == "exr":
            depth = 32 if re.search(r"float|32", codec, re.I) else 16
        else:
            m = re.search(r"(8|10|12|16|32)\s*bits?|rgba?\s*(8|10|12|16)|^(8|10|16)", codec, re.I)
            depth = int(next(g for g in m.groups() if g)) if m else int(settings.get("BitDepth") or 8)
        per_pixel = table.get(depth) or next((table[k] for k in sorted(table) if k >= depth), table.get(8, table[min(table)]))
        if fmt in ("jpg", "jpeg"):
            per_pixel *= LEVEL_SCALE.get(str(settings.get("VideoQuality")), 1)
        video_bits = per_pixel * 8 * pixels * frames
        basis = f"{name} at {depth}-bit"
    else:
        q = settings.get("VideoQuality")
        kbps = q if isinstance(q, (int, float)) and not isinstance(q, bool) and q > 0 else int(q) if isinstance(q, str) and q.isdigit() and int(q) > 0 else 0
        if kbps:
            video_bits = kbps * 1000 * seconds
            basis = f"{kbps:,} kb/s"
        else:
            fixed = next((f for f in FIXED_BPP if re.search(f[0], codec, re.I)), None)
            auto = fixed or next((a for a in AUTO_BPP if re.search(a[0], codec, re.I)), None)
            video_bits = (auto[1] if auto else 0.4) * LEVEL_SCALE.get(str(q), 1) * pixels * frames
            exact = False
            basis = f"{fixed[2]} data rate" if fixed else f"{auto[2] if auto else codec or 'codec'} on automatic quality"
    audio_bits = 0.0
    if export_audio:
        acodec = str(settings.get("AudioCodec") or "").lower()
        if acodec in ("lpcm", "pcm", "linearpcm", "wav"):
            audio_bits = channels * int(settings.get("AudioBitDepth") or 24) * int(settings.get("AudioSampleRate") or 48000) * seconds
        else:
            audio_bits = COMPRESSED_AUDIO_KBPS * 1000 * seconds
            exact = False
    total = round((round(video_bits / 8) + round(audio_bits / 8)) * 1.01)  # container overhead
    return {"bytes": total, "exact": exact, "basis": basis}


def format_bytes(n) -> str:
    if n is None:
        return ""
    if n >= 1e12:
        return f"{n / 1e12:.2f} TB"
    if n >= 1e9:
        return f"{n / 1e9:.0f} GB" if n >= 1e10 else f"{n / 1e9:.1f} GB"
    if n >= 1e6:
        return f"{n / 1e6:.0f} MB" if n >= 1e8 else f"{n / 1e6:.1f} MB"
    if n >= 1e3:
        return f"{round(n / 1e3)} KB"
    return f"{n} B"


def size_label(est) -> str:
    """'~1.2 GB' for a typical figure, '1.2 GB' for an exact one, '' when nothing is known."""
    if not est or est.get("bytes") is None:
        return ""
    return ("" if est.get("exact") else "~") + format_bytes(est["bytes"])


def estimate_for(prof: dict, info, frames: int, kind: str):
    if not info or not frames:
        return None
    res = prof.get("resolution") or {}
    return estimate_bytes(prof["format"], prof["codec"], prof.get("settings"), res.get("width") or info.get("width"),
                          res.get("height") or info.get("height"), prof.get("frameRate") or info.get("fps"), frames, kind)


# ----------------------------------------------------------------- the In/Out range

def in_out_range(raw_in, raw_out, start: int, end: int, fps: float, drop: bool = False):
    """Pure part of timeline_in_out(): Resolve's relative frames become absolute (numbers that only make sense as absolute
    frames pass through), swapped if reversed, clamped to the timeline; None when they cover the whole timeline."""
    abs_in, abs_out = int(raw_in), int(raw_out)
    if abs_out <= end - start or abs_in < start:
        abs_in += start
        abs_out += start
    if abs_out < abs_in:
        abs_in, abs_out = abs_out, abs_in
    abs_in = min(end, max(start, abs_in))
    abs_out = min(end, max(start, abs_out))
    if abs_in == start and abs_out == end:
        return None
    return {"absIn": abs_in, "absOut": abs_out, "frames": abs_out - abs_in + 1,
            "tcIn": frames_to_tc(abs_in, fps, drop), "tcOut": frames_to_tc(abs_out, fps, drop)}


def marks_within(marks: list, rng) -> tuple[list, list]:
    """The marks inside the In/Out range: a mark that starts outside is skipped, one that runs past Out is clipped to it."""
    if not rng:
        return list(marks), []
    kept, skipped = [], []
    for m in marks:
        if m["absIn"] < rng["absIn"] or m["absIn"] > rng["absOut"]:
            skipped.append(m)
        elif m["absOut"] > rng["absOut"]:
            kept.append({**m, "absOut": rng["absOut"], "durationFrames": rng["absOut"] - m["absIn"] + 1, "clipped": True})
        else:
            kept.append(m)
    return kept, skipped


def expand_items(profiles, targets, timeline_name, project_name, marks, template, out_dir, now=None, underscore_spaces=False, rng=None, info=None):
    """Pure expansion of one timeline into job items; mirrors src/batch.js expandItems(). `rng` is the In/Out range the final
    renders and the marks are kept within (None = whole timeline); `info` the timeline's facts for durations and size estimates."""
    items, notes = [], []
    marks, skipped = marks_within(marks, rng)
    for kind in ("cut", "still"):
        n = sum(1 for m in skipped if m["kind"] == kind)
        if n:
            notes.append({"profile": None, "profileName": None, "timeline": timeline_name,
                          "message": f"{n} {kind}{'' if n == 1 else 's'} outside In/Out on '{timeline_name}' left out"})
    final_frames = rng["frames"] if rng else (info or {}).get("frames") or 0
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
                          "fileName": render_name(template or DEFAULT_TEMPLATE, ctx, now, underscore_spaces) + prof["fileSuffix"],
                          "range": (rng["absIn"], rng["absOut"]) if rng else None, "mark": None,
                          "frames": final_frames, "estimate": estimate_for(prof, info, final_frames, "final")})
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
            mark = dict(m)
            if m.get("clipped") and info:
                mark["tcOut"] = frames_to_tc(m["absOut"], info["fps"], info.get("drop", False))
                mark["duration"] = duration_label(m["durationFrames"], info["fps"])
            frames = 1 if kind == "still" else m["durationFrames"]
            items.append({"profile": prof, "timeline": timeline_name, "kind": kind, "targetDir": target_dir,
                          "fileName": name + prof["fileSuffix"], "range": (m["absIn"], m["absOut"]), "mark": mark,
                          "frames": frames, "estimate": estimate_for(prof, info, frames, kind)})
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
    end = int(tl.GetEndFrame() or start)
    width = height = 0
    try:
        width = int(float(tl.GetSetting("timelineResolutionWidth") or 0))
        height = int(float(tl.GetSetting("timelineResolutionHeight") or 0))
    except Exception:  # noqa: BLE001
        pass
    info = {"name": tl.GetName(), "startFrame": start, "endFrame": end, "fps": fps, "drop": drop, "frames": end - start + 1,
            "width": width, "height": height, "vertical": bool(width and height and height > width)}
    info["inOut"] = timeline_in_out(tl, info)
    return info


def timeline_in_out(tl, info: dict):
    """The In and Out set in Resolve (I and O) as absolute frames, or None when none is set or this Resolve has no
    Timeline.GetMarkInOut (older than 19). Mirrors ResolveBridge.timelineInOut()."""
    getter = getattr(tl, "GetMarkInOut", None)
    if not callable(getter):
        return None
    try:
        raw = getter() or {}
    except Exception:  # noqa: BLE001
        return None
    pick = (raw.get("video") or raw.get("audio")) if isinstance(raw, dict) else None
    if not pick or pick.get("in") is None or pick.get("out") is None:
        return None
    try:
        return in_out_range(int(pick["in"]), int(pick["out"]), info["startFrame"], info["endFrame"], info["fps"], info["drop"])
    except (TypeError, ValueError):
        return None


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


# SetRenderSettings takes the whole dictionary or none of it, so settings go in in
# layers (mirrors src/resolve.js applyRenderSettings): the essentials together, the
# picture size as a pair, then every extra on its own; a refused extra is dropped.
HARD_GROUPS = (("TargetDir",), ("CustomName",), ("SelectAllFrames", "MarkIn", "MarkOut"))
SIZE_KEYS = ("FormatWidth", "FormatHeight")
SETTING_HINTS = {
    "TargetDir": "Check that the output folder exists and that Resolve can write to it.",
    "CustomName": "The file name has a character Resolve does not accept; change the name template.",
    "SelectAllFrames": "Resolve did not accept the frame range; clear the marks and set them again.",
    "MarkIn": "The in and out frames fall outside the timeline; clear the marks and set them again.",
    "MarkOut": "The in and out frames fall outside the timeline; clear the marks and set them again.",
    "FormatWidth": "That size is not offered for this codec. Pick a standard size, or leave the size empty to use the timeline's.",
    "FormatHeight": "That size is not offered for this codec. Pick a standard size, or leave the size empty to use the timeline's.",
}


def apply_render_settings(project, settings: dict, lenient: bool = False, label: str = "") -> tuple[dict, list]:
    """Returns (applied, rejected). Raises RuntimeError naming the key when an essential one is refused."""
    applied: dict = {}
    rejected: list = []

    def try_set(part: dict) -> bool:
        if not part:
            return True
        if project.SetRenderSettings(part):
            applied.update(part)
            return True
        return False

    def refuse(key: str) -> RuntimeError:
        return RuntimeError(f"Resolve refused the render setting {key} = {settings[key]!r}{label}. {SETTING_HINTS.get(key, '')}".strip())

    hard_keys = [k for g in HARD_GROUPS for k in g]
    if not try_set({k: settings[k] for k in hard_keys if k in settings}):
        for group in HARD_GROUPS:
            part = {k: settings[k] for k in group if k in settings}
            if part and not try_set(part):
                raise refuse(next(iter(part)))
    size = {k: settings[k] for k in SIZE_KEYS if k in settings}
    if size and not try_set(size):
        if not lenient:
            raise refuse("FormatWidth")
        rejected.extend(size.items())
    skip = set(hard_keys) | set(SIZE_KEYS)
    for key, value in settings.items():
        if key in skip:
            continue
        if not try_set({key: value}):
            rejected.append((key, value))
    return applied, rejected


def apply_profile(project, profile: dict, target_dir: str, custom_name: str, rng=None) -> tuple[dict, list]:
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
    return apply_render_settings(project, settings, label=f" for {profile.get('name') or profile['id']!r} ({fmt[1]}/{codec[1]})")


def queue_jobs(project, profiles, targets, out_dir: str, template: str, timelines=None, clear_queue=False, log=print, underscore_spaces=True, use_in_out=True):
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
            info, marks = timeline_marks(tl) if needs_marks else (timeline_info(tl), [])
            rng = info.get("inOut") if use_in_out else None
            if rng:
                log(f"'{tl_name}': In to Out {rng['tcIn']} -> {rng['tcOut']} ({rng['frames']} frames); the final renders that range and marks outside it are left out")
            items, tl_notes = expand_items(profiles, targets, tl_name, project_name, marks, template, out_dir, None, underscore_spaces, rng=rng, info=info)
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
                    _applied, rejected = apply_profile(project, prof, it["targetDir"], it["fileName"], it["range"])
                    if rejected:
                        log(f"Resolve does not offer {', '.join(f'{k}={v!r}' for k, v in rejected)} for {prof['format']}/{prof['codec']}; {prof['name']} renders without")
                    job_id = project.AddRenderJob()
                    if not job_id:
                        raise RuntimeError("AddRenderJob returned nothing")
                    jobs.append({"jobId": job_id, "timeline": tl_name, "profile": prof["id"], "profileName": prof["name"],
                                 "label": it["label"], "kind": it["kind"], "format": prof["format"], "codec": prof["codec"],
                                 "resolution": prof.get("resolution"), "mark": it["mark"], "estimate": it.get("estimate"),
                                 "targetDir": it["targetDir"], "fileName": it["fileName"]})
                    where = f" [{it['mark']['tcIn']}{' -> ' + it['mark']['tcOut'] if it['kind'] == 'cut' else ''}]" if it["mark"] else ""
                    size = f" ({size_label(it['estimate'])})" if size_label(it.get("estimate")) else ""
                    log(f"Queued {prof['name']} for '{tl_name}'{where} -> {os.path.join(it['targetDir'], it['fileName'])}{size}")
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


# ----------------------------------------------------------------------------- portal upload (plugin API v2, see portal-kit/)

PORTAL_API = {"ping": "/api/plugin/ping", "projects": "/api/plugin/projects", "deliverables": "/api/plugin/deliverables"}
CONTENT_TYPES = {"mp4": "video/mp4", "m4v": "video/x-m4v", "mov": "video/quicktime", "mxf": "application/mxf", "avi": "video/x-msvideo",
                 "mkv": "video/x-matroska", "webm": "video/webm", "tif": "image/tiff", "tiff": "image/tiff", "jpg": "image/jpeg",
                 "jpeg": "image/jpeg", "png": "image/png", "exr": "image/x-exr", "dpx": "image/x-dpx", "gif": "image/gif",
                 "wav": "audio/wav", "aif": "audio/aiff", "aiff": "audio/aiff", "mp3": "audio/mpeg", "aac": "audio/aac"}


def portal_base(url: str) -> str:
    """The portal's address: a scheme added, trailing slashes and any pasted /api/... path removed."""
    u = (url or "").strip()
    if not u:
        raise SystemExit("No portal URL. Set EXPORTX_PORTAL_URL or pass --portal-url.")
    if not re.match(r"^https?://", u, re.I):
        u = "https://" + u
    u = u.rstrip("/")
    return re.sub(r"/api(/.*)?$", "", u, flags=re.I)


def content_type_for(name: str) -> str:
    m = re.search(r"\.([a-z0-9]{1,5})$", name.lower())
    return CONTENT_TYPES.get(m.group(1), "application/octet-stream") if m else "application/octet-stream"


def find_outputs(target_dir: str, base_name: str, since: float = 0.0) -> list[str]:
    if not os.path.isdir(target_dir):
        return []
    rx = re.compile("^" + re.escape(base_name) + r"(?:[._-]?\d+)?\.[a-z0-9]{1,5}$", re.I)
    out = []
    for name in sorted(os.listdir(target_dir)):
        full = os.path.join(target_dir, name)
        if rx.match(name) and os.path.isfile(full) and os.path.getsize(full) > 0 and os.path.getmtime(full) >= since - 1:
            out.append(full)
    return out


def build_manifest(project_name: str, timeline: str, fps: float | None, frames: int | None, jobs: list[dict], template: str, since: float):
    """One entry per output file found on disk (with its local path), plus what was expected but not found."""
    files, missing = [], []
    for job in jobs:
        outputs = find_outputs(job["targetDir"], job["fileName"], since)
        if not outputs:
            missing.append(job["fileName"])
            continue
        for i, full in enumerate(outputs):
            key = f"{job['jobId']}-{i + 1}" if len(outputs) > 1 else str(job["jobId"])
            st = os.stat(full)
            mark = job.get("mark") or {}
            res = job.get("resolution") or {}
            files.append({
                "key": key, "path": full, "fileName": os.path.basename(full), "kind": job["kind"], "label": job.get("label"),
                "deliverableId": job["profile"], "deliverableName": job.get("profileName"), "timeline": job["timeline"],
                "format": job.get("format"), "codec": job.get("codec"), "width": res.get("width"), "height": res.get("height"),
                "tcIn": mark.get("tcIn"), "tcOut": mark.get("tcOut"), "durationFrames": mark.get("durationFrames"), "markIndex": mark.get("index"),
                "bytes": st.st_size,
            })
    batch_id = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%d") + "-" + os.urandom(4).hex()
    manifest = {"source": "exportx", "exportxVersion": "python", "project": project_name, "timeline": timeline, "fps": fps, "frames": frames,
                "namePattern": template, "batchId": batch_id}
    return manifest, files, missing


def register_input(manifest: dict, f: dict) -> dict:
    fps = manifest.get("fps")
    duration = None
    if f["kind"] == "cut" and f.get("durationFrames") and fps:
        duration = round(f["durationFrames"] / fps, 2)
    elif f["kind"] == "final" and manifest.get("frames") and fps:
        duration = round(manifest["frames"] / fps, 2)
    out = {"fileName": f["fileName"], "kind": f["kind"], "size_bytes": f["bytes"], "content_type": content_type_for(f["fileName"]),
           "meta": {"kind": f["kind"], "deliverableId": f["deliverableId"], "deliverableName": f["deliverableName"], "label": f["label"],
                    "fileName": f["fileName"], "timeline": f["timeline"] or manifest["timeline"], "resolveProject": manifest["project"],
                    "format": f["format"], "codec": f["codec"], "fps": fps, "tcIn": f["tcIn"], "tcOut": f["tcOut"],
                    "durationFrames": f["durationFrames"], "markIndex": f["markIndex"], "batchId": manifest["batchId"], "exportxVersion": "python"}}
    if f.get("width") and f.get("height"):
        out["width"], out["height"] = f["width"], f["height"]
    if duration:
        out["duration_seconds"] = duration
    if f.get("deliverableName"):
        out["deliverableName"] = f["deliverableName"]
    return out


class _Slice:
    """A byte range of a file as a body urllib streams, counting what went out."""

    def __init__(self, path: str, start: int, end: int, on_progress=None):
        self.f = open(path, "rb")  # noqa: SIM115 - closed in close()
        self.f.seek(start)
        self.left = end - start
        self.total = end - start
        self.on_progress = on_progress

    def read(self, n=-1):
        if self.left <= 0:
            return b""
        chunk = self.f.read(self.left if n is None or n < 0 else min(n, self.left))
        self.left -= len(chunk)
        if self.on_progress:
            self.on_progress(self.total - self.left)
        return chunk

    def __len__(self):
        return self.total

    def close(self):
        self.f.close()


def portal_json(base: str, token: str, method: str, path: str, body=None, timeout=60):
    hdrs = {"Accept": "application/json", "User-Agent": "ExportX-python", "Authorization": f"Bearer {token}"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8")
            return json.loads(text) if text else {"ok": True}
    except urllib.error.HTTPError as err:
        text = err.read().decode("utf-8", "replace")
        try:
            msg = json.loads(text).get("message") or json.loads(text).get("error") or text
        except ValueError:
            msg = text or str(err)
        raise RuntimeError(f"Portal: {msg}") from None
    except urllib.error.URLError as err:
        raise RuntimeError(f"Portal {method} {path}: {err.reason}") from None


def put_slice(url: str, path: str, start: int, end: int, content_type: str | None, on_progress=None, retries: int = 4) -> str:
    """PUT a byte range to a signed address; the ETag the store answered comes back."""
    last: Exception | None = None
    for attempt in range(retries):
        body = _Slice(path, start, end, on_progress)
        hdrs = {"Content-Length": str(end - start), "User-Agent": "ExportX-python"}
        if content_type:
            hdrs["Content-Type"] = content_type
            hdrs["x-upsert"] = "true"
        req = urllib.request.Request(url, data=body, method="PUT", headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                return resp.headers.get("ETag") or ""
        except urllib.error.HTTPError as err:
            last = RuntimeError(f"The file store answered {err.code}")
            if 400 <= err.code < 500 and err.code not in (408, 429):
                raise last from None
        except urllib.error.URLError as err:
            last = RuntimeError(f"Upload failed: {err.reason}")
        finally:
            body.close()
        time.sleep(0.8 * (2 ** attempt))
    raise last or RuntimeError("Upload failed")


def portal_projects(url: str, token: str) -> list[dict]:
    base = portal_base(url)
    return portal_json(base, token, "GET", PORTAL_API["projects"], timeout=15).get("projects") or []


def upload_file(base: str, token: str, project_id: str, path: str, file_name: str, log=print) -> str:
    size = os.path.getsize(path)
    ctype = content_type_for(file_name)
    last = [-1]

    def progress(sent, total=size):
        pct = int(sent * 100 / total) if total else 100
        if pct // 10 != last[0] // 10:
            last[0] = pct
            log(f"  {file_name}: {pct}%")

    plan = portal_json(base, token, "POST", PORTAL_API["deliverables"], {"action": "upload_url", "projectId": project_id, "filename": file_name, "size": size, "contentType": ctype})
    if plan.get("mode") == "tus":
        plan = portal_json(base, token, "POST", PORTAL_API["deliverables"], {"action": "upload_url", "projectId": project_id, "filename": file_name, "size": size, "contentType": ctype, "small": True, "path": plan.get("path")})
    if plan.get("mode") == "put":
        put_slice(plan["url"], path, 0, size, ctype, progress)
        return plan["path"]
    if plan.get("mode") != "multipart":
        raise RuntimeError(f"The portal asked for an upload mode this script does not speak ({plan.get('mode')})")
    part_size = int(plan["partSize"])
    receipts = []
    done_before = 0
    for part in plan["parts"]:
        start = (part["partNumber"] - 1) * part_size
        end = min(start + part_size, size)
        etag = put_slice(part["url"], path, start, end, None, lambda sent, d=done_before: progress(d + sent))
        if not etag:
            raise RuntimeError("A part uploaded but its receipt (ETag) did not come back")
        receipts.append({"partNumber": part["partNumber"], "etag": etag})
        done_before += end - start
    portal_json(base, token, "POST", PORTAL_API["deliverables"], {"action": "complete_upload", "projectId": project_id, "path": plan["path"], "uploadId": plan["uploadId"], "parts": receipts})
    return plan["path"]


def upload_to_portal(url: str, token: str, project_id: str, manifest: dict, files: list[dict], log=print) -> dict:
    if not token:
        raise SystemExit("No plugin key. Set EXPORTX_PORTAL_TOKEN or pass --portal-token (Settings > ExportX on the portal makes one).")
    if not project_id:
        raise SystemExit("No portal project. Pass --portal-project <id> (see --list-projects) or set EXPORTX_PORTAL_PROJECT.")
    if not files:
        raise SystemExit("Nothing to upload: no finished files were found on disk.")
    base = portal_base(url)
    ping = portal_json(base, token, "GET", PORTAL_API["ping"], timeout=15)
    log(f"Portal: {ping.get('portal') or base} (plugin API v{ping.get('version', '?')}, {ping.get('storage', '?')} storage)")
    view = portal_json(base, token, "GET", PORTAL_API["deliverables"] + "?projectId=" + urllib.request.quote(project_id, safe=""), timeout=30)
    log(f"Project: {view['project']['name']}; boxes: {', '.join(b['name'] for b in view.get('boxes') or []) or '(none)'}")
    uploaded, failed, total = [], [], 0
    for f in files:
        try:
            stored = upload_file(base, token, project_id, f["path"], f["fileName"], log)
            reg = portal_json(base, token, "POST", PORTAL_API["deliverables"], {"action": "register", "projectId": project_id, "file_path": stored, **register_input(manifest, f)})
            uploaded.append(reg.get("label") or f["fileName"])
            total += f["bytes"]
            box = (reg.get("box") or {}).get("name")
            log(f"  on the portal: {reg.get('label')}" + (f" (box: {box})" if box else " (not in a box yet)"))
        except RuntimeError as err:
            failed.append({"label": f["fileName"], "error": str(err)})
            log(f"  {f['fileName']}: FAILED {err}")
    done = portal_json(base, token, "POST", PORTAL_API["deliverables"], {"action": "batch", "projectId": project_id, "batchId": manifest["batchId"],
                       "resolveProject": manifest["project"], "timeline": manifest["timeline"], "uploaded": uploaded, "failed": failed, "bytes": total})
    log(f"Upload {'finished with errors' if failed else 'complete'}: {len(uploaded)} of {len(files)} in {view['project']['name']}" + (f" -> {done.get('url')}" if done.get("url") else ""))
    return {"batchId": manifest["batchId"], "uploaded": uploaded, "failed": failed, "url": done.get("url")}


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
    p.add_argument("--whole-timeline", action="store_true", default=os.environ.get("EXPORTX_WHOLE") == "1",
                   help="ignore the In and Out set in Resolve and export each timeline whole (default: In to Out when one is set)")
    p.add_argument("--upload", action="store_true", help="after --wait, upload the finished files into a project on the portal (EXPORTX_PORTAL_URL/TOKEN/PROJECT)")
    p.add_argument("--portal-url", default=os.environ.get("EXPORTX_PORTAL_URL"), help="portal URL for --upload")
    p.add_argument("--portal-token", default=os.environ.get("EXPORTX_PORTAL_TOKEN"), help="the plugin key from the portal (Settings > ExportX)")
    p.add_argument("--portal-project", default=os.environ.get("EXPORTX_PORTAL_PROJECT"), help="the portal project id the files go in")
    p.add_argument("--list-projects", action="store_true", help="list the portal's projects (id, job number, name) and exit")
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
    # In/Out: Resolve reports relative frames; a range covering everything means "whole timeline"
    rng = in_out_range(48, 1223, 86400, 86400 + 24 * 60 - 1, 24)
    assert rng == {"absIn": 86448, "absOut": 87623, "frames": 1176, "tcIn": "01:00:02:00", "tcOut": "01:00:50:23"}, rng
    assert in_out_range(0, 24 * 60 - 1, 86400, 86400 + 24 * 60 - 1, 24) is None
    assert in_out_range(87623, 86448, 86400, 86400 + 24 * 60 - 1, 24)["absIn"] == 86448  # absolute, reversed
    kept, skipped = marks_within(marks, {"absIn": 86450, "absOut": 86460})
    assert not kept and len(skipped) == 2
    kept, skipped = marks_within(marks, {"absIn": 86400, "absOut": 86450})
    assert kept[0]["clipped"] and kept[0]["absOut"] == 86450 and kept[0]["durationFrames"] == 27 and [m["kind"] for m in skipped] == ["still"]
    tl_info = {"name": "Main Edit", "startFrame": 86400, "endFrame": 87839, "fps": 24.0, "drop": False, "frames": 1440, "width": 1920, "height": 1080}
    items, notes = expand_items([by_id["final-4k-h265"], by_id["cuts-social-1080"], by_id["stills-tiff"]], TARGETS, "Main Edit", "P", marks,
                                DEFAULT_TEMPLATE, "/out", fixed, rng={"absIn": 86400, "absOut": 86450, "frames": 51}, info=tl_info)
    assert len(items) == 2 and items[0]["range"] == (86400, 86450) and items[0]["frames"] == 51, items
    assert items[1]["range"] == (86424, 86450) and items[1]["mark"]["tcOut"] == "01:00:02:02" and items[1]["mark"]["clipped"] and items[1]["frames"] == 27
    assert notes and notes[0]["message"] == "1 still outside In/Out on 'Main Edit' left out", notes
    assert items[0]["estimate"]["bytes"] == round((45000 * 1000 * 51 / 24 / 8 + 320 * 1000 * 51 / 24 / 8) * 1.01) and items[0]["estimate"]["basis"] == "45,000 kb/s"
    # size estimates mirror src/estimate.js
    est = estimate_bytes("mp4", "H264", {"VideoQuality": 16000, "AudioCodec": "aac"}, 1920, 1080, 30, 1800)
    assert est["bytes"] == round((120_000_000 + 2_400_000) * 1.01) and not est["exact"], est
    est = estimate_bytes("mp4", "H264", {"VideoQuality": 16000, "AudioCodec": "lpcm", "AudioBitDepth": 24, "AudioSampleRate": 48000}, 1920, 1080, 30, 1800)
    assert est["bytes"] == round((120_000_000 + 17_280_000) * 1.01) and est["exact"], est
    assert estimate_bytes("tif", "RGB16", {}, 1920, 1080, 24, 1, "still") == {"bytes": round(1920 * 1080 * 6 * 1.01), "exact": True, "basis": "TIFF at 16-bit"}
    assert estimate_bytes("exr", "RGB half (PIZ)", {}, 1920, 1080, 24, 1, "still")["bytes"] == round(1920 * 1080 * 3 * 1.01)
    prores = estimate_bytes("mov", "ProRes422HQ", {"AudioCodec": "lpcm"}, 1920, 1080, 30, 30)
    assert prores["basis"] == "ProRes 422 HQ data rate" and not prores["exact"] and 26e6 < prores["bytes"] < 29e6, prores
    assert estimate_bytes("mp4", "H265", {}, 1920, 1080, 24, 240)["bytes"] < estimate_bytes("mp4", "H264", {}, 1920, 1080, 24, 240)["bytes"]
    assert estimate_bytes("jpg", "auto", {"VideoQuality": "Best"}, 100, 100, 24, 1, "still")["bytes"] > estimate_bytes("jpg", "auto", {"VideoQuality": "High"}, 100, 100, 24, 1, "still")["bytes"]
    assert estimate_bytes("mp4", "H264", {}, 0, 0, 24, 10)["bytes"] is None
    assert format_bytes(1_234_567_890) == "1.2 GB" and format_bytes(24_000_000) == "24.0 MB" and format_bytes(950) == "950 B"
    assert size_label({"bytes": 1_234_567_890, "exact": False}) == "~1.2 GB" and size_label({"bytes": 6_220_800, "exact": True}) == "6.2 MB" and size_label(None) == ""
    class _Picky:
        def __init__(self, refuse):
            self.refuse, self.current = refuse, {}

        def SetRenderSettings(self, part):  # noqa: N802 - Resolve's name
            if any(k in self.refuse for k in part):
                return False
            self.current.update(part)
            return True

    picky = _Picky({"VideoQuality", "AudioBitDepth"})
    applied, rejected = apply_render_settings(picky, {"TargetDir": "/out", "CustomName": "x", "SelectAllFrames": True, "FormatWidth": 1280, "FormatHeight": 720, "ExportVideo": True, "VideoQuality": "Medium", "AudioBitDepth": 16, "NetworkOptimization": True})
    assert [k for k, _ in rejected] == ["VideoQuality", "AudioBitDepth"] and "VideoQuality" not in applied and applied["NetworkOptimization"] is True
    assert picky.current["FormatWidth"] == 1280 and picky.current["TargetDir"] == "/out"
    try:
        apply_render_settings(_Picky({"TargetDir"}), {"TargetDir": "/out", "CustomName": "x"})
    except RuntimeError as err:
        assert "TargetDir" in str(err) and "output folder" in str(err)
    else:
        raise AssertionError("a refused TargetDir should stop the job")
    try:
        apply_render_settings(_Picky({"FormatWidth"}), {"TargetDir": "/out", "FormatWidth": 3840, "FormatHeight": 2160})
    except RuntimeError as err:
        assert "FormatWidth" in str(err)
    else:
        raise AssertionError("a refused size should stop a deliverable")
    _, lenient_rejected = apply_render_settings(_Picky({"FormatWidth"}), {"TargetDir": "/out", "FormatWidth": 3840, "FormatHeight": 2160}, lenient=True)
    assert [k for k, _ in lenient_rejected] == ["FormatWidth", "FormatHeight"]
    assert portal_base("portal.example.com/") == "https://portal.example.com"
    assert portal_base("http://localhost:8787/api/plugin/ping") == "http://localhost:8787"
    assert content_type_for("A.MOV") == "video/quicktime" and content_type_for("x.weird") == "application/octet-stream"
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        for name in ("261017_P_Final.mp4", "261017_P_Still_01_0086500.tif", "261017_P_Still_010_0086500.tif", "other.mp4"):
            Path(tmp, name).write_bytes(b"x" * 10)
        assert [os.path.basename(f) for f in find_outputs(tmp, "261017_P_Final")] == ["261017_P_Final.mp4"]
        assert [os.path.basename(f) for f in find_outputs(tmp, "261017_P_Still_01")] == ["261017_P_Still_01_0086500.tif"]
        pjobs = [{"jobId": "j1", "timeline": "TL", "profile": "final-4k-h265", "profileName": "Final 4K", "label": "Final", "kind": "final",
                  "format": "mp4", "codec": "H265", "resolution": {"width": 3840, "height": 2160}, "mark": None, "targetDir": tmp, "fileName": "261017_P_Final"},
                 {"jobId": "j2", "timeline": "TL", "profile": "x", "profileName": "X", "label": "X", "kind": "cut", "format": "mp4", "codec": "H264",
                  "resolution": None, "mark": None, "targetDir": tmp, "fileName": "missing"}]
        manifest, pfiles, missing = build_manifest("P", "TL", 24.0, 240, pjobs, DEFAULT_TEMPLATE, 0)
        assert manifest["source"] == "exportx" and missing == ["missing"] and re.match(r"^\d{8}-[0-9a-f]{8}$", manifest["batchId"])
        assert pfiles[0]["key"] == "j1" and pfiles[0]["bytes"] == 10 and pfiles[0]["width"] == 3840 and pfiles[0]["path"].endswith("261017_P_Final.mp4")
        reg = register_input(manifest, pfiles[0])
        assert reg["kind"] == "final" and reg["duration_seconds"] == 10.0 and reg["width"] == 3840 and reg["meta"]["resolveProject"] == "P" and "path" not in reg
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

    if args.list_projects:
        for pr in portal_projects(args.portal_url, args.portal_token or ""):
            print(f"  {pr.get('id'):<24} {pr.get('jobNumber') or '':<14} {pr.get('name')}" + (f"  ({pr.get('client')})" if pr.get("client") else ""))
        return 0

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
        print("Timelines:")
        for n in names:
            ti = timeline_info(timeline_by_name(project, n))
            io = (f"In to Out {ti['inOut']['tcIn']} -> {ti['inOut']['tcOut']} ({ti['inOut']['frames']} frames)" if ti.get("inOut")
                  else "no In/Out set, exports whole")
            print(f"  {n}{' (current)' if n == current else ''}: {ti['width']}x{ti['height']}{' vertical' if ti['vertical'] else ''}, "
                  f"{ti['fps']:g} fps, {ti['frames']} frames, {io}")
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
                                     underscore_spaces=not args.keep_spaces and CONFIG["underscore_spaces"],
                                     use_in_out=not (args.whole_timeline or (not argv and CONFIG.get("whole_timeline"))))
    print(f"\nQueued {len(jobs)} job(s); {len(errors)} skipped; {len(notes)} note(s).")
    if not jobs:
        return 1

    if args.upload and not (args.wait or (not argv and CONFIG["wait"])):
        raise SystemExit("--upload needs --wait (the files have to exist before they can be uploaded).")
    if args.upload:
        portal_base(args.portal_url)  # fail early on a missing URL
        if not args.portal_project:
            raise SystemExit("--upload needs --portal-project <id> (run --list-projects to see them) or EXPORTX_PORTAL_PROJECT.")
    queued_at = time.time()
    should_render = args.render or args.wait or os.environ.get("EXPORTX_RENDER") == "1" or (not argv and CONFIG["render"])
    if should_render:
        ids = [j["jobId"] for j in jobs]
        if not project.StartRendering(ids, False):
            raise SystemExit("Resolve refused to start rendering (is a render already running?)")
        print("Rendering started.")
        if args.wait or (not argv and CONFIG["wait"]):
            statuses = wait_for_jobs(project, ids)
            failed = [jid for jid, s in statuses.items() if s["status"] != "complete"]
            for jid in failed:
                print(f"  {jid}: {statuses[jid]['status']} {statuses[jid].get('error') or ''}")
            if not failed:
                print("All renders complete.")
            if args.upload:
                done_jobs = [j for j in jobs if statuses.get(j["jobId"], {}).get("status") == "complete"]
                tl = project.GetCurrentTimeline()
                fps = parse_fps(tl.GetSetting("timelineFrameRate")) if tl else None
                frames = (int(tl.GetEndFrame()) - int(tl.GetStartFrame()) + 1) if tl else None
                manifest, pfiles, missing = build_manifest(project.GetName(), ", ".join(timelines) if timelines else (tl.GetName() if tl else ""),
                                                           fps, frames, done_jobs, args.name, queued_at)
                for name in missing:
                    print(f"  no file found for {name}")
                result = upload_to_portal(args.portal_url, args.portal_token, args.portal_project, manifest, pfiles)
                if result["failed"]:
                    return 3
            if failed:
                return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
