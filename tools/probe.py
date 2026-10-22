"""在真实浏览器里求值一段 JS 并打印结果（调试用）

用法: python tools/probe.py <url> "<js表达式>" [width] [height]
"""
import json
import subprocess
import sys
import time
import urllib.request

import websocket

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"


def main() -> None:
    url, expr = sys.argv[1], sys.argv[2]
    width = int(sys.argv[3]) if len(sys.argv) > 3 else 1200
    height = int(sys.argv[4]) if len(sys.argv) > 4 else 900

    proc = subprocess.Popen(
        [EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--incognito",
         "--remote-debugging-port=9444", "--remote-allow-origins=*",
         "--force-prefers-reduced-motion",
         "--user-data-dir=" + r"D:\Project\资产统计\.edge-probe", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        ws_url = None
        for _ in range(40):
            try:
                tabs = json.load(urllib.request.urlopen("http://127.0.0.1:9444/json", timeout=1))
                page = [t for t in tabs if t["type"] == "page"]
                if page:
                    ws_url = page[0]["webSocketDebuggerUrl"]
                    break
            except Exception:
                pass
            time.sleep(0.25)
        ws = websocket.create_connection(ws_url, timeout=30)
        mid = 0

        def call(method, **params):
            nonlocal mid
            mid += 1
            ws.send(json.dumps({"id": mid, "method": method, "params": params}))
            while True:
                m = json.loads(ws.recv())
                if m.get("id") == mid:
                    return m.get("result", {})

        call("Emulation.setDeviceMetricsOverride", width=width, height=height, deviceScaleFactor=1, mobile=False)
        call("Page.enable")
        call("Page.navigate", url=url)
        time.sleep(3.0)
        r = call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        print(json.dumps(r.get("result", {}).get("value"), ensure_ascii=False, indent=2))
        ws.close()
    finally:
        proc.terminate()


if __name__ == "__main__":
    main()
