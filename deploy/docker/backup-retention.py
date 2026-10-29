#!/usr/bin/env python3
"""Plan GFS retention, then explicitly quarantine or restore; never delete payloads."""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

BACKUP = re.compile(r"\d{8}T\d{6}Z")
TX = re.compile(r"retention_[a-f0-9]{32}")
FILES = {"database.dump", "manifest.json", "credentials.vault.json", "compose.yaml",
         "env.backup", "web.env.sanitized", "worker.env.sanitized", "restore-verification.json"}


class Refused(Exception):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise Refused("unsafe_directory")
    return info


def read_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise Refused("unsafe_file")
        if path.name.endswith(".json") and info.st_size > 65536:
            raise Refused("metadata_too_large")
        h = hashlib.sha256()
        chunks = []
        with os.fdopen(fd, "rb", closefd=False) as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                h.update(block)
                if path.name.endswith(".json"):
                    chunks.append(block)
        return {"sha256": h.hexdigest(), "size": info.st_size, "inode": info.st_ino,
                "mtimeNs": info.st_mtime_ns}, b"".join(chunks)
    finally:
        os.close(fd)


def inspect(path):
    if not BACKUP.fullmatch(path.name):
        raise Refused("invalid_backup_name")
    info = directory(path)
    present = {p.name for p in path.iterdir()}
    if not {"database.dump", "manifest.json", "compose.yaml"} <= present or not present <= FILES:
        raise Refused("incomplete_or_unknown_backup_files")
    files, metadata = {}, {}
    for name in sorted(present):
        files[name], raw = read_file(path / name)
        if name.endswith(".json"):
            metadata[name] = json.loads(raw)
    manifest = metadata["manifest.json"]
    if not isinstance(manifest, dict):
        raise Refused("invalid_manifest")
    stamp = dt.datetime.strptime(path.name, "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)
    if manifest.get("createdAt") != path.name or not isinstance(manifest.get("database"), dict):
        raise Refused("invalid_manifest")
    if not files["database.dump"]["size"] or files["database.dump"]["sha256"] != manifest.get("databaseDumpSha256"):
        raise Refused("dump_checksum_mismatch")
    vault = manifest.get("credentialsSha256")
    if vault == "none":
        if "credentials.vault.json" in files:
            raise Refused("unexpected_vault")
    elif files.get("credentials.vault.json", {}).get("sha256") != vault or not isinstance(metadata.get("credentials.vault.json"), dict):
        raise Refused("vault_checksum_mismatch")
    if not files["compose.yaml"]["size"]:
        raise Refused("configuration_missing")
    return {"id": path.name, "inode": info.st_ino, "files": files}, stamp, metadata.get("restore-verification.json")


def scan(root):
    directory(root)
    result = []
    for child in sorted(root.iterdir()):
        if BACKUP.fullmatch(child.name):
            result.append(inspect(child))
    return result


def verified_latest(entry, stamp, receipt, today):
    if (not isinstance(receipt, dict) or receipt.get("schemaVersion") != 1
            or receipt.get("result") != "verified"
            or receipt.get("scope") != "database-stats-and-vault-integrity"):
        raise Refused("latest_restore_verification_missing")
    expected = {name: value["sha256"] for name, value in entry["files"].items() if name != "restore-verification.json"}
    if receipt.get("files") != expected:
        raise Refused("latest_restore_verification_stale")
    verified = dt.datetime.fromisoformat(receipt["verifiedAt"].replace("Z", "+00:00"))
    if verified.tzinfo is None or not stamp.date() <= verified.date() <= today or (today - verified.date()).days > 7:
        raise Refused("latest_restore_verification_expired")


def plan(root, today):
    entries = scan(root)
    if not entries:
        raise Refused("no_backups")
    if any(stamp.date() > today for _, stamp, _ in entries):
        raise Refused("future_backup")
    latest = max(entries, key=lambda item: item[1])
    verified_latest(*latest, today)
    keep = {latest[0]["id"]: {"latest_verified"}}
    buckets = {}
    this_week = today - dt.timedelta(days=today.weekday())
    month = today.year * 12 + today.month - 1
    for entry, stamp, _ in entries:
        date = stamp.date()
        keys = []
        if 0 <= (today - date).days < 7:
            keys.append(("daily", date.isoformat()))
        week = date - dt.timedelta(days=date.weekday())
        if 0 <= (this_week - week).days < 28:
            keys.append(("weekly", week.isoformat()))
        if 0 <= month - (date.year * 12 + date.month - 1) < 3:
            keys.append(("monthly", date.strftime("%Y-%m")))
        for key in keys:
            if key not in buckets or stamp > buckets[key][1]:
                buckets[key] = (entry, stamp)
    for (kind, _), (entry, _) in buckets.items():
        keep.setdefault(entry["id"], set()).add(kind)
    snapshot = {entry["id"]: entry for entry, _, _ in entries}
    payload = {"mode": "quarantine", "dayUtc": today.isoformat(), "policy": {"dailyDays": 7, "weeklyWeeks": 4, "monthlyMonths": 3},
               "rootIdentity": [root.stat().st_dev, root.stat().st_ino], "snapshot": snapshot,
               "keep": {key: sorted(value) for key, value in sorted(keep.items())},
               "move": sorted(set(snapshot) - set(keep))}
    return payload


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_json(path, value):
    temp = path.parent / (".writing_" + uuid.uuid4().hex)
    fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(canonical(value) + b"\n")
            stream.flush()
            os.fsync(fd)
        os.replace(temp, path)
        sync_directory(path.parent)
    finally:
        os.close(fd)
        if temp.exists():
            temp.unlink()  # Only this invocation's newly created metadata temp, never payloads.


def transaction(root, name):
    if not TX.fullmatch(name):
        raise Refused("invalid_transaction")
    parent = root / ".quarantine"
    directory(parent)
    target = parent / name
    directory(target)
    _, raw = read_file(target / "journal.json")
    journal = json.loads(raw)
    if (not isinstance(journal, dict) or journal.get("id") != name
            or not isinstance(journal.get("snapshot"), dict) or not isinstance(journal.get("moved"), list)
            or journal.get("rootIdentity") != [root.stat().st_dev, root.stat().st_ino]):
        raise Refused("invalid_journal")
    return target, journal


def restore_plan(root, name):
    target, journal = transaction(root, name)
    entries = {}
    # The filesystem is authoritative across a crash between rename and journal
    # update; every payload must still match the original frozen snapshot.
    present = [p.name for p in target.iterdir() if BACKUP.fullmatch(p.name)]
    for backup in sorted(present):
        if not BACKUP.fullmatch(backup) or (root / backup).exists() or (root / backup).is_symlink():
            raise Refused("restore_conflict")
        entry, _, _ = inspect(target / backup)
        if entry != journal["snapshot"].get(backup):
            raise Refused("quarantined_backup_changed")
        entries[backup] = entry
    if not entries:
        raise Refused("nothing_to_restore")
    return {"mode": "restore", "transaction": name, "rootIdentity": journal["rootIdentity"], "snapshot": entries, "move": sorted(entries)}


def apply(root, payload):
    if payload["mode"] == "restore":
        target, journal = transaction(root, payload["transaction"])
        for name in payload["move"]:
            expected = {key: value for key, value in payload["snapshot"].items() if (target / key).exists()}
            if restore_plan(root, payload["transaction"])["snapshot"] != expected:
                raise Refused("restore_snapshot_changed")
            if (root / name).exists() or (root / name).is_symlink():
                raise Refused("restore_conflict")
            os.rename(target / name, root / name)
            sync_directory(root)
            sync_directory(target)
            if name in journal["moved"]:
                journal["moved"].remove(name)
            atomic_json(target / "journal.json", journal)
        return {"transaction": payload["transaction"], "restored": payload["move"]}
    parent = root / ".quarantine"
    if not parent.exists():
        parent.mkdir(mode=0o700)
        sync_directory(root)
    directory(parent)
    name = "retention_" + uuid.uuid4().hex
    target = parent / name
    target.mkdir(mode=0o700)
    sync_directory(parent)
    journal = {"id": name, "rootIdentity": payload["rootIdentity"], "snapshot": payload["snapshot"], "moved": []}
    atomic_json(target / "journal.json", journal)
    remaining = dict(payload["snapshot"])
    for backup in payload["move"]:
        current = {entry["id"]: entry for entry, _, _ in scan(root)}
        if current != remaining:
            raise Refused("backup_snapshot_changed")
        os.rename(root / backup, target / backup)
        sync_directory(root)
        sync_directory(target)
        journal["moved"].append(backup)
        remaining.pop(backup)
        atomic_json(target / "journal.json", journal)
    return {"transaction": name, "quarantined": payload["move"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--now", type=dt.date.fromisoformat, default=dt.datetime.now(dt.timezone.utc).date())
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expect-plan-sha256")
    parser.add_argument("--restore")
    args = parser.parse_args()
    directory(args.root)  # Reject a symlink root before canonicalizing its parents.
    root = args.root.resolve()
    lock = None
    try:
        if args.apply:
            if not re.fullmatch(r"[a-f0-9]{64}", args.expect_plan_sha256 or ""):
                raise Refused("explicit_plan_hash_required")
            lock = os.open(root / ".retention.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            info = os.fstat(lock)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise Refused("unsafe_lock")
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        payload = restore_plan(root, args.restore) if args.restore else plan(root, args.now)
        plan_hash = digest(payload)
        if args.apply and args.expect_plan_sha256 != plan_hash:
            raise Refused("plan_changed")
        result = apply(root, payload) if args.apply else {}
        print(json.dumps({"status": "applied" if args.apply else "dry_run", "mode": payload["mode"],
                          "planSha256": plan_hash, "keep": payload.get("keep", {}), "move": payload["move"], **result}, sort_keys=True))
    finally:
        if lock is not None:
            os.close(lock)


if __name__ == "__main__":
    try:
        main()
    except Refused as error:
        print(json.dumps({"status": "refused", "reason": str(error)}), file=sys.stderr)
        sys.exit(2)
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        print(json.dumps({"status": "refused", "reason": "invalid_or_changed_backup_evidence"}), file=sys.stderr)
        sys.exit(2)
