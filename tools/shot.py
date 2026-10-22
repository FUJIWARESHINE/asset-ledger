"""用 CDP 精确模拟设备视口截图（绕开 headless --window-size 在 Windows DPI 下不准的问题）

用法: python tools/shot.py <url> <out.png> [width] [height] [scale]
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.request

import websocket

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
# 可换端口：9333 常被其他工具占走，默认改用 9345
PORT = int(os.environ.get("SHOT_PORT", "9345"))


def main() -> None:
    url = sys.argv[1]
    out = sys.argv[2]
    width = int(sys.argv[3]) if len(sys.argv) > 3 else 390
    height = int(sys.argv[4]) if len(sys.argv) > 4 else 844
    scale = float(sys.argv[5]) if len(sys.argv) > 5 else 2
    mobile = width < 600

    proc = subprocess.Popen(
        [EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
         "--force-prefers-reduced-motion", f"--remote-debugging-port={PORT}",
         "--remote-allow-origins=*", "--incognito", "--disable-application-cache",
         "--user-data-dir=" + r"D:\Project\资产统计\.edge-cdp", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        ws_url = None
        for _ in range(40):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=1))
                page = [t for t in tabs if t["type"] == "page"]
                if page:
                    ws_url = page[0]["webSocketDebuggerUrl"]
                    break
            except Exception:
                pass
            time.sleep(0.25)
        if not ws_url:
            raise SystemExit("无法连接 CDP")

        ws = websocket.create_connection(ws_url, timeout=30)
        mid = 0

        def call(method, **params):
            nonlocal mid
            mid += 1
            ws.send(json.dumps({"id": mid, "method": method, "params": params}))
            while True:
                msg = json.loads(ws.recv())
                if msg.get("id") == mid:
                    return msg.get("result", {})

        call("Emulation.setDeviceMetricsOverride", width=width, height=height,
             deviceScaleFactor=scale, mobile=mobile)
        if mobile:
            call("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=5)

        call("Page.enable")
        call("Page.navigate", url=url)
        time.sleep(3.2)

        # 量一下真实视口与是否横向溢出
        probe = call("Runtime.evaluate", expression=(
            "JSON.stringify({vw:innerWidth,vh:innerHeight,"
            "html:document.documentElement.scrollWidth,body:document.body.scrollWidth})"
        ), returnByValue=True)
        print("viewport:", probe.get("result", {}).get("value"))

        viewport_only = os.environ.get("SHOT_VIEWPORT") == "1"

        # SHOT_JS="js" → 截图前先执行一段脚本（切视图、开弹层等）
        pre_js = os.environ.get("SHOT_JS")
        if pre_js:
            call("Runtime.evaluate", expression=pre_js, returnByValue=True, awaitPromise=True)
            time.sleep(0.7)

        # SHOT_HOVER="css selector" → 截图前把鼠标移到该元素中心，用于拍 :hover 态
        hover_sel = os.environ.get("SHOT_HOVER")
        if hover_sel:
            box = call("Runtime.evaluate", expression=(
                "(()=>{const el=document.querySelector(%r);if(!el)return '';"
                "el.scrollIntoView({block:'center'});"
                "const r=el.getBoundingClientRect();"
                "return JSON.stringify({x:Math.round(r.left+r.width/2),"
                "y:Math.round(r.top+r.height/2)});})()" % hover_sel
            ), returnByValue=True)
            val = box.get("result", {}).get("value")
            if val:
                pos = json.loads(val)
                call("Input.dispatchMouseEvent", type="mouseMoved",
                     x=pos["x"], y=pos["y"], buttons=0)
                time.sleep(0.5)
                print("hover:", hover_sel, pos)
                chk = call("Runtime.evaluate", expression=(
                    "(()=>{const el=document.querySelector(%r);if(!el)return '';"
                    "const go=el.querySelector('.ac-go,.asset-go');"
                    "return JSON.stringify({hover:el.matches(':hover'),"
                    "goOpacity:go?getComputedStyle(go).opacity:null,"
                    "dayOpacity:(el.querySelector('.ac-day')?getComputedStyle(el.querySelector('.ac-day')).opacity:null)});})()"
                    % hover_sel
                ), returnByValue=True)
                print("hover-check:", chk.get("result", {}).get("value"))

        if viewport_only:
            # captureBeyondViewport 会重建合成帧、丢掉 :hover，只截视口时直接拍
            shot = call("Page.captureScreenshot", format="png")
        else:
            full = call("Page.getLayoutMetrics")
            clip_h = min(full["cssContentSize"]["height"], height * 3)
            shot = call("Page.captureScreenshot", format="png", captureBeyondViewport=True,
                        clip={"x": 0, "y": 0, "width": width, "height": clip_h, "scale": 1})
        with open(out, "wb") as f:
            f.write(base64.b64decode(shot["data"]))
        print("saved", out)
        ws.close()
    finally:
        proc.terminate()


if __name__ == "__main__":
    main()
