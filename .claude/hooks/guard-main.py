#!/usr/bin/env python3
"""Claude Code PreToolUse hook: blocks git commands that would change main directly.

Blocks, for Bash commands:
- git commit / merge / rebase / cherry-pick / revert / am while the target checkout is on main;
- git push targeting main (explicit refspec, or no refspec while on main);
- --no-verify on commit or push.
Exit code 2 makes Claude Code refuse the command and show the message to the agent.
"""
import json
import re
import shlex
import subprocess
import sys

MAIN_REFS = {"main", "refs/heads/main"}
CHANGES_CURRENT_BRANCH = {"commit", "merge", "rebase", "cherry-pick", "revert", "am"}
HELP = "Toda mudança vai por branch de trabalho num worktree próprio e PR para a main (veja o AGENTS.md)."


def block(message: str) -> None:
    print(f"{message} {HELP}", file=sys.stderr)
    sys.exit(2)


def current_branch(path: str) -> str:
    result = subprocess.run(
        ["git", "-C", path, "symbolic-ref", "--short", "HEAD"],
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def targets_main(refspec: str) -> bool:
    destination = refspec.lstrip("+").split(":")[-1]
    return destination in MAIN_REFS


def check(tokens: list[str], cwd: str) -> None:
    # skip leading VAR=value assignments
    while tokens and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[0]):
        tokens = tokens[1:]
    if not tokens or tokens[0] != "git":
        return
    path = cwd
    i = 1
    while i < len(tokens) and tokens[i].startswith("-"):
        if tokens[i] == "-C" and i + 1 < len(tokens):
            path = tokens[i + 1]
            i += 2
        elif tokens[i] == "-c" and i + 1 < len(tokens):
            i += 2
        else:
            i += 1
    if i >= len(tokens):
        return
    sub, args = tokens[i], tokens[i + 1 :]

    if sub in {"commit", "push"} and ("--no-verify" in args or (sub == "commit" and "-n" in args)):
        block("Comando recusado: não use --no-verify.")

    if sub in CHANGES_CURRENT_BRANCH and current_branch(path) == "main":
        block(f"Comando recusado: 'git {sub}' na branch main.")

    if sub == "push":
        positional = [a for a in args if not a.startswith("-")]
        refspecs = positional[1:]  # first positional is the remote
        if any(targets_main(r) for r in refspecs):
            block("Push recusado: a main só recebe mudanças por pull request.")
        if not refspecs and current_branch(path) == "main":
            block("Push recusado: você está na main.")


def main() -> None:
    data = json.load(sys.stdin)
    if data.get("tool_name") != "Bash":
        return
    command = data.get("tool_input", {}).get("command", "")
    cwd = data.get("cwd") or "."
    for part in re.split(r"&&|\|\||;|\||\n", command):
        try:
            tokens = shlex.split(part)
        except ValueError:
            tokens = part.split()
        check(tokens, cwd)


if __name__ == "__main__":
    main()
