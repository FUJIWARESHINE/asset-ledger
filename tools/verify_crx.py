#!/usr/bin/env python3
"""独立校验 crx3 完整性：解析头部、比对扩展 ID、用 openssl 验证 RSA 签名。

打包脚本自带一次签名自校验，这里再做一遍「从文件反解」的校验，
确保写出去的东西真的能被 Chromium 解析。

用法：python tools/verify_crx.py dist/asset-ledger-extension-1.0.0.crx
"""

from __future__ import annotations

import argparse
import hashlib
import io
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

CRX3_MAGIC = b"CRX3 SignedData\x00"


def read_varint(buf: bytes, i: int) -> tuple[int, int]:
    shift = value = 0
    while True:
        byte = buf[i]
        i += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, i
        shift += 7


def parse_message(buf: bytes) -> list[tuple[int, bytes]]:
    out, i = [], 0
    while i < len(buf):
        key, i = read_varint(buf, i)
        field, wire = key >> 3, key & 7
        if wire != 2:
            raise SystemExit(f"字段 {field} 的 wire type {wire} 不是 length-delimited")
        length, i = read_varint(buf, i)
        out.append((field, buf[i : i + length]))
        i += length
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("crx", nargs="?", help="crx 路径（默认取 dist/ 下最新一个）")
    ap.add_argument("--expect-id", default="", help="期望的扩展 ID，一般读 dist/extension-id.txt")
    args = ap.parse_args()

    root = Path(__file__).resolve().parent.parent
    crx_path = Path(args.crx) if args.crx else sorted((root / "dist").glob("*.crx"))[-1]
    raw = crx_path.read_bytes()

    if raw[:4] != b"Cr24":
        raise SystemExit(f"{crx_path.name} 不是 crx（魔数不对）")
    version, header_len = struct.unpack("<II", raw[4:12])
    if version != 3:
        raise SystemExit(f"只支持 crx3，实际版本 {version}")
    header = raw[12 : 12 + header_len]
    zip_bytes = raw[12 + header_len :]

    fields = dict(parse_message(header))
    if 2 not in fields or 10000 not in fields:
        raise SystemExit("头部缺少 sha256_with_rsa 或 signed_header_data")
    pub, sig = [payload for _, payload in parse_message(fields[2])]
    signed_header_data = fields[10000]

    ext_id = "".join(chr(ord("a") + int(c, 16)) for c in hashlib.sha256(pub).hexdigest()[:32])
    declared = bytes.fromhex("".join(f"{ord(ch) - ord('a'):x}" for ch in ext_id))
    if parse_message(signed_header_data)[0][1] != declared:
        raise SystemExit("signed_header_data 里的 crx_id 与公钥不一致")

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        if zf.testzip() is not None:
            raise SystemExit("zip 内容损坏")
        if "manifest.json" not in zf.namelist():
            raise SystemExit("manifest.json 不在 zip 根目录")
        manifest_version = __import__("json").loads(zf.read("manifest.json"))["version"]

    ok = True
    if args.expect_id:
        expected = Path(args.expect_id).read_text(encoding="utf-8").strip() \
            if Path(args.expect_id).exists() else args.expect_id.strip()
        ok = expected == ext_id
        print(f"扩展 ID  {ext_id}  (期望 {expected}) {'✅' if ok else '❌'}")

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        (tmpdir / "pub.der").write_bytes(pub)
        (tmpdir / "sig.bin").write_bytes(sig)
        (tmpdir / "signed.bin").write_bytes(
            CRX3_MAGIC + struct.pack("<I", len(signed_header_data)) + signed_header_data + zip_bytes
        )
        openssl = shutil.which("openssl")
        if not openssl:
            raise SystemExit("找不到 openssl，无法验签")
        res = subprocess.run(
            [openssl, "dgst", "-sha256", "-verify", str(tmpdir / "pub.der"),
             "-signature", str(tmpdir / "sig.bin"), str(tmpdir / "signed.bin")],
            capture_output=True,
        )
        verified = b"Verified OK" in res.stdout

    print(f"结构     crx3 头部 {header_len} B，zip {len(zip_bytes) / 1024:.1f} KB，manifest {manifest_version} ✅")
    print(f"签名     {'Verified OK ✅' if verified else '验签失败 ❌'}")
    sys.exit(0 if (verified and ok) else 1)


if __name__ == "__main__":
    main()
