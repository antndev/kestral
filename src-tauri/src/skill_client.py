#!/usr/bin/env python3
"""Talk to the running Kestral app over its local MCP endpoint.

Only the standard library is used, so nothing has to be installed.

The access token is read from Kestral's data directory by this script itself.
It is never passed as an argument, so it does not appear in a process list or in
a chat transcript. Every call goes through the same chain as the MCP tools:
the AI access switch, the per-host policy, the approval dialog and the audit log.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

URL = os.environ.get("KESTRAL_URL", "http://127.0.0.1:4517/mcp")
SESSION = {"id": None, "token": None}

HELP = """kestral — control your servers through the running Kestral app

  status                          Is the app reachable, is AI access on
  hosts                           List the hosts you are allowed to see
  run <host> <command...>         Run a command on a host
  ls <host> <path>                List a remote directory
  upload <host> <local> <remote>  Copy a local file to the host
  download <host> <remote> <local>  Copy a file from the host
  audit                           Show what has been done
  tools                           List everything the app currently offers
  call <tool> <json>              Call any tool directly

  --json                          Print the raw result

File transfer uses the per-host FILE policy, which is separate from the command
policy. A host may allow commands and still refuse file access.

For upload/download the LOCAL path is any path on this machine, absolute or
~/-relative; name it directly. Protected paths (e.g. .ssh/authorized_keys) are the
exception: naming one is refused and stops AI access.
"""

def die(msg, code=1):
    print("kestral: %s" % msg, file=sys.stderr)
    sys.exit(code)

def data_dir():
    override = os.environ.get("KESTRAL_DATA_DIR") or os.environ.get("HELMSMAN_DATA_DIR")
    if override:
        return Path(override)
    home = Path(os.environ.get("USERPROFILE") or os.path.expanduser("~"))
    new = home / ".kestral"
    if new.exists():
        return new
    old = home / ".helmsman"
    return old if old.exists() else new

def read_token():
    p = data_dir() / "mcp_token"
    try:
        value = p.read_text(encoding="utf-8").strip()
    except OSError:
        die("no token at %s. Is Kestral installed and has it been started once?" % p)
    if not value:
        die("token file %s is empty" % p)
    return value

def rpc(method, params=None, notify=False):
    body = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        body["params"] = params
    if not notify:
        body["id"] = 1

    req = urllib.request.Request(URL, data=json.dumps(body).encode("utf-8"), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json, text/event-stream")
    req.add_header("Authorization", "Bearer %s" % SESSION["token"])
    if SESSION["id"]:
        req.add_header("Mcp-Session-Id", SESSION["id"])

    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            sid = resp.headers.get("mcp-session-id")
            if sid:
                SESSION["id"] = sid
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code == 401:
            die("not authorised. The token was rotated, open Kestral and connect again.")
        die("server returned %s" % e.code)
    except urllib.error.URLError as e:
        die("cannot reach Kestral at %s (%s). Is the app running?" % (URL, e.reason))

    if notify:
        return None
    return unwrap(raw)

def unwrap(raw):
    """Antworten kommen als Server-Sent-Events: Zeilen der Form 'data: {json}'."""
    found = None
    for line in raw.splitlines():
        if not line.startswith("data:"):
            continue
        chunk = line[5:].strip()
        if not chunk:
            continue
        try:
            obj = json.loads(chunk)
        except ValueError:
            continue
        if isinstance(obj, dict) and ("result" in obj or "error" in obj):
            found = obj
    if found is None:
        try:
            found = json.loads(raw)
        except ValueError:
            die("could not parse the response from Kestral")
    if "error" in found:
        die(found["error"].get("message", "unknown error"))
    return found.get("result", {})

def connect():
    SESSION["token"] = read_token()
    rpc(
        "initialize",
        {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "kestral-skill", "version": "1"},
        },
    )
    rpc("notifications/initialized", notify=True)

def text_of(result):
    parts = [
        c.get("text", "")
        for c in result.get("content", [])
        if isinstance(c, dict) and c.get("type") == "text"
    ]
    return "\n".join(parts).strip()

def call(name, args=None):
    result = rpc("tools/call", {"name": name, "arguments": args or {}})
    body = text_of(result)
    if result.get("isError"):
        die(body or "the app refused this call")
    return body

def main():
    argv = [a for a in sys.argv[1:]]
    as_json = "--json" in argv
    argv = [a for a in argv if a != "--json"]

    if not argv or argv[0] in ("-h", "--help", "help"):
        print(HELP)
        return 0 if argv else 2

    cmd, rest = argv[0], argv[1:]
    connect()

    if cmd == "status":
        result = rpc("tools/list")
        names = [t.get("name") for t in result.get("tools", [])]
        print("app:        reachable")
        print("tools:      %d available" % len(names))
        probe = call("get_audit_log") if "get_audit_log" in names else ""
        print("ai access:  %s" % ("on" if probe != "" else "on or restricted"))
        return 0

    if cmd == "tools":
        result = rpc("tools/list")
        if as_json:
            print(json.dumps(result, indent=2))
            return 0
        for t in result.get("tools", []):
            print("%-18s %s" % (t.get("name", ""), (t.get("description") or "").split("\n")[0]))
        return 0

    if cmd == "hosts":
        print(call("list_hosts"))
        return 0

    if cmd == "audit":
        print(call("get_audit_log"))
        return 0

    if cmd == "run":
        if len(rest) < 2:
            die('usage: run <host> <command...>', 2)
        print(call("run_command", {"host_id": rest[0], "command": " ".join(rest[1:])}))
        return 0

    if cmd == "ls":
        if len(rest) != 2:
            die('usage: ls <host> <path>', 2)
        print(call("sftp_list", {"host_id": rest[0], "path": rest[1]}))
        return 0

    if cmd == "upload":
        if len(rest) != 3:
            die('usage: upload <host> <local-path> <remote-path>', 2)
        print(call("sftp_upload", {"host_id": rest[0], "local_path": rest[1], "remote_path": rest[2]}))
        return 0

    if cmd == "download":
        if len(rest) != 3:
            die('usage: download <host> <remote-path> <local-path>', 2)
        print(call("sftp_download", {"host_id": rest[0], "remote_path": rest[1], "local_path": rest[2]}))
        return 0

    if cmd == "call":
        if len(rest) < 1:
            die('usage: call <tool> [json-arguments]', 2)
        raw = rest[1] if len(rest) > 1 else "{}"
        try:
            args = json.loads(raw)
        except ValueError:
            die("the arguments must be valid JSON, got: %s" % raw, 2)
        print(call(rest[0], args))
        return 0

    die('unknown command "%s". Try --help.' % cmd, 2)

if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
