import argparse
import subprocess
import sys

from . import __version__


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    # Internal modes never bypass the isolation wrapper for public reads.
    if argv and argv[0] == "_query":
        from .query import worker_main
        return worker_main()
    if argv and argv[0] == "_probe" and len(argv) == 3:
        from .query import probe_main
        return probe_main(*argv[1:])
    if argv and argv[0] == "_serve" and len(argv) == 5:
        from .lifecycle import service_main
        return service_main(*argv[1:])
    parser = argparse.ArgumentParser(
        prog="tokenflow", description="TokenFlow：本地只读 Copilot Token 明细",
        epilog="默认数据库：~/.copilot/session-store.db；只支持可验证 sandbox-exec 隔离的 macOS。",
    )
    parser.add_argument("--version", action="version", version=__version__)
    commands = parser.add_subparsers(dest="action")
    start_parser = commands.add_parser("start", help="后台启动并打开浏览器")
    start_parser.add_argument("--db", help="已有 SQLite 数据库路径")
    start_parser.add_argument("--no-browser", action="store_true", help="仅输出地址，不打开浏览器")
    commands.add_parser("stop", help="停止当前用户实例")
    args = parser.parse_args(argv)
    if args.action is None:
        parser.print_help()
        return 0
    from .lifecycle import DEFAULT_DB, start, stop
    from .store import StoreError
    try:
        if args.action == "stop":
            stopped = stop()
            print("TokenFlow 已停止" if stopped else "TokenFlow 未运行")
            return 0
        info, reused = start(args.db or DEFAULT_DB)
        url = f"http://127.0.0.1:{info['port']}/#key={info['token']}"
        print("TokenFlow 已复用现有实例" if reused else "TokenFlow 已启动")
        print(url)
        if not args.no_browser:
            try:
                result = subprocess.run(
                    ["/usr/bin/open", url], stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
                )
                if result.returncode:
                    print("无法打开默认浏览器；服务仍在运行，请手动打开上方完整地址", file=sys.stderr)
            except (OSError, subprocess.TimeoutExpired):
                print("无法打开默认浏览器；服务仍在运行，请手动打开上方完整地址", file=sys.stderr)
        return 0
    except (RuntimeError, ValueError, OSError, StoreError) as error:
        print(f"TokenFlow：{error}", file=sys.stderr)
        return 1
