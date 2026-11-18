"""Tatoeba local data builder (chunked).

Downloads Tatoeba per-language dump files, unpacks them and builds a compact
local dataset in data/ that replaces the live Tatoeba API for the trainer app.

Instead of one monolithic file per dataset, the output is split into small
chunk files so a client fetches only the chunks it needs (lazy loading):

    data/manifest.json             build metadata: version, chunk lists, stats
    data/widx/widx_<char>.json     inverted index {token: [engId,...]} per first char
    data/packs/pack_<bucket>.json  { engId: {t, a, l} } per eng id bucket
    data/ru/ru_<bucket>.jsonl      russian sentences per rus id bucket

Usage:
    python tools/build_index.py [--limit N] [--dump-dir DIR] [--out DIR]
                                [--skip-download] [--chunk-size N]

Options:
    --limit N       process at most N lines from each dump (test mode)
    --dump-dir DIR  cache directory for downloaded .bz2 dumps
    --out DIR       output directory for generated data files
    --skip-download reuse existing dump files without re-downloading
    --chunk-size N  id buckets for packs/ru chunks (default 100000)
"""

import argparse
import bz2
import json
import os
import re
import shutil
import sys
import tempfile
import unicodedata
import urllib.request
from datetime import datetime, timezone

BASE_URL = "https://downloads.tatoeba.org/exports/per_language"

FILES = [
    ("eng_sentences.tsv.bz2", "eng"),
    ("rus_sentences.tsv.bz2", "rus"),
    ("eng-rus_links.tsv.bz2", "links"),
    ("eng_sentences_with_audio.tsv.bz2", "audio"),
]

AUDIO_BASE_URL = "https://tatoeba.org/audio"

HARD_LIMIT = 100 * 1024 * 1024


def out_paths(root):
    return {
        "manifest": os.path.join(root, "manifest.json"),
        "widx": os.path.join(root, "widx"),
        "packs": os.path.join(root, "packs"),
        "ru": os.path.join(root, "ru"),
    }


def legacy_paths(root):
    return [
        os.path.join(root, n)
        for n in ("eng.jsonl", "ru.jsonl", "links.json", "audio.json", "wordidx.json", "version.json")
    ]


def download(url, dest):
    if os.path.isfile(dest) and os.path.getsize(dest) > 0:
        return False
    tmp = dest + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": "tatoeba-local-builder/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as fh:
        while True:
            chunk = resp.read(1 << 16)
            if not chunk:
                break
            fh.write(chunk)
    os.replace(tmp, dest)
    return True


def iter_tsv(dump_dir, name, limit):
    path = os.path.join(dump_dir, name)
    with bz2.open(path, "rt", encoding="utf-8", newline="") as fh:
        for i, line in enumerate(fh):
            if limit and i >= limit:
                break
            line = line.rstrip("\n")
            if not line:
                continue
            yield line.split("\t")


def tokenize_key(text):
    norm = unicodedata.normalize("NFKC", text).lower()
    return [t.strip("'") for t in re.findall(r"[0-9a-z']+", norm) if t.strip("'")]


def main():
    parser = argparse.ArgumentParser(description="Build local Tatoeba dataset.")
    parser.add_argument("--limit", type=int, default=0, help="max lines per dump (test mode)")
    parser.add_argument("--dump-dir", default=os.path.join(tempfile.gettempdir(), "kilo", "tatoeba_dumps"))
    parser.add_argument("--out", default="data")
    parser.add_argument("--skip-download", action="store_true")
    parser.add_argument("--chunk-size", type=int, default=100000, help="id bucket size for packs/ru chunks")
    args = parser.parse_args()

    if sys.stdout and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    dump_dir = args.dump_dir
    out_dir = args.out
    limit = args.limit or None
    chunk = max(1, args.chunk_size)
    os.makedirs(dump_dir, exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)

    SUBDIR = {"eng": "eng", "rus": "rus", "links": "eng", "audio": "eng"}

    if not args.skip_download:
        for name, kind in FILES:
            url = f"{BASE_URL}/{SUBDIR[kind]}/{name}"
            print(f"download {url} ...", flush=True)
            download(url, os.path.join(dump_dir, name))
    else:
        missing = [n for n, _ in FILES if not os.path.isfile(os.path.join(dump_dir, n))]
        if missing:
            print(f"missing dumps in {dump_dir}: {missing}", file=sys.stderr)
            sys.exit(1)

    print("loading english sentences ...", flush=True)
    eng_text = {}
    eng_words = {}
    for cols in iter_tsv(dump_dir, "eng_sentences.tsv.bz2", limit):
        if len(cols) >= 3:
            sid = int(cols[0])
            text = cols[2]
            w = len(text.split())
            if text.strip() and 1 <= w <= 20:
                eng_text[sid] = text
                eng_words[sid] = w
    print(f"  english sentences (<=20 words): {len(eng_text)}", flush=True)

    print("loading russian sentences ...", flush=True)
    rus_text = {}
    for cols in iter_tsv(dump_dir, "rus_sentences.tsv.bz2", limit):
        if len(cols) >= 3:
            sid = int(cols[0])
            text = cols[2]
            if text.strip():
                rus_text[sid] = text
    print(f"  russian sentences: {len(rus_text)}", flush=True)

    print("loading audio records ...", flush=True)
    audio_raw = {}
    for cols in iter_tsv(dump_dir, "eng_sentences_with_audio.tsv.bz2", limit):
        if len(cols) >= 2:
            sid = int(cols[0])
            aid = int(cols[1])
            audio_raw.setdefault(sid, []).append(aid)
    print(f"  audio records: {sum(len(v) for v in audio_raw.values())} for {len(audio_raw)} sentences", flush=True)

    kept_ids = {sid for sid in eng_text if sid in audio_raw}
    print(f"english sentences with audio: {len(kept_ids)}", flush=True)

    print("loading links ...", flush=True)
    links = {}
    for cols in iter_tsv(dump_dir, "eng-rus_links.tsv.bz2", limit):
        if len(cols) < 2:
            continue
        a, b = int(cols[0]), int(cols[1])
        if a in eng_text and b in rus_text:
            links.setdefault(a, set()).add(b)
        elif b in eng_text and a in rus_text:
            links.setdefault(b, set()).add(a)
    print(f"  links: {sum(len(v) for v in links.values())} pairs", flush=True)

    kept_links = {sid: sorted(links[sid]) for sid in kept_ids if sid in links}
    kept_audio = {sid: audio_raw[sid] for sid in kept_ids}
    referenced_ru = set()
    for ids in kept_links.values():
        referenced_ru.update(ids)

    print("building word index (split by first char) ...", flush=True)
    wordidx = {}
    for sid in kept_ids:
        for tok in set(tokenize_key(eng_text[sid])):
            wordidx.setdefault(tok, set()).add(sid)
    by_char = {}
    for tok, ids in sorted(wordidx.items()):
        by_char.setdefault(tok[0], {})[tok] = sorted(ids)

    paths = out_paths(out_dir)
    for p in legacy_paths(out_dir):
        if os.path.exists(p):
            os.remove(p)
    for d in (paths["widx"], paths["packs"], paths["ru"]):
        if os.path.isdir(d):
            shutil.rmtree(d)
        os.makedirs(d, exist_ok=True)

    target_estimate = 0

    widx_chars = []
    widx_sizes = []
    for c, data in sorted(by_char.items()):
        fname = os.path.join(paths["widx"], f"widx_{c}.json")
        with open(fname, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
        widx_chars.append(c)
        widx_sizes.append(f"{c}:{os.path.getsize(fname)}")
        target_estimate += os.path.getsize(fname)

    pack_buckets = {}
    for sid in kept_ids:
        pack_buckets.setdefault(sid // chunk, {})[str(sid)] = {
            "t": eng_text[sid],
            "a": kept_audio[sid],
            "l": kept_links.get(sid, []),
        }
    pack_list = []
    pack_sizes = []
    for bucket in sorted(pack_buckets):
        fname = os.path.join(paths["packs"], f"pack_{bucket}.json")
        with open(fname, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(pack_buckets[bucket], fh, ensure_ascii=False, separators=(",", ":"))
        pack_list.append(bucket)
        pack_sizes.append(f"{bucket}:{os.path.getsize(fname)}")
        target_estimate += os.path.getsize(fname)

    ru_buckets = {}
    for rid in referenced_ru:
        ru_buckets.setdefault(rid // chunk, []).append(rid)
    ru_list = []
    ru_sizes = []
    for bucket in sorted(ru_buckets):
        fname = os.path.join(paths["ru"], f"ru_{bucket}.jsonl")
        with open(fname, "w", encoding="utf-8", newline="\n") as fh:
            for rid in sorted(ru_buckets[bucket]):
                fh.write(json.dumps({"id": rid, "t": rus_text[rid]}, ensure_ascii=False) + "\n")
        ru_list.append(bucket)
        ru_sizes.append(f"{bucket}:{os.path.getsize(fname)}")
        target_estimate += os.path.getsize(fname)

    meta = {
        "chunk": chunk,
        "build_date": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "dump_date": "2026-11-14",
        "source": BASE_URL,
        "stat": {
            "eng_with_audio": len(kept_ids),
            "ru_sentences": len(referenced_ru),
            "links": sum(len(v) for v in kept_links.values()),
            "audio_records": sum(len(v) for v in kept_audio.values()),
            "word_tokens": len(wordidx),
        },
        "widx": widx_chars,
        "packs": pack_list,
        "ru": ru_list,
    }
    with open(paths["manifest"], "w", encoding="utf-8", newline="\n") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)
    target_estimate += os.path.getsize(paths["manifest"])

    print(flush=True)
    for c, w in zip(widx_chars, widx_sizes):
        print(f"  widx_{w}", flush=True)
    for w in pack_sizes:
        print(f"  pack_{w}", flush=True)
    for w in ru_sizes:
        print(f"  ru_{w}", flush=True)
    print(f"  {paths['manifest']}  {os.path.getsize(paths['manifest'])/1024:.1f} KiB", flush=True)
    print(f"\ntotal data: {target_estimate/1024/1024:.1f} MiB, largest file check:", end=" ", flush=True)
    largest = 0
    for root, _dirs, files in os.walk(out_dir):
        for name in files:
            p = os.path.join(root, name)
            largest = max(largest, os.path.getsize(p))
    print(f"{largest/1024/1024:.2f} MiB", flush=True)
    if largest > HARD_LIMIT:
        print("FAIL: a chunk file exceeds the 100 MiB GitHub Pages per-file limit", file=sys.stderr)
        sys.exit(2)
    print("done.", flush=True)


if __name__ == "__main__":
    main()