#!/usr/bin/env python3
"""把 extension/ 打包成可安装的 .crx3 + 商店用 .zip + 自托管更新清单 update.xml。

只依赖标准库和 openssl 命令行，不需要 pip 安装任何东西。

用法：
    python tools/build_extension.py                    # 输出到 dist/
    python tools/build_extension.py --gen-key          # 首次：生成签名密钥
    python tools/build_extension.py --base-url https://.../download/v1.0.0

密钥决定扩展 ID，**一旦发布就不能换**，否则已装用户不会收到更新。
CI 里通过环境变量 EXTENSION_KEY_PEM 传入密钥内容（见 .github/workflows）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT_DIR = ROOT / "extension"
DEFAULT_KEY = ROOT / "extension-key.pem"
DIST = ROOT / "dist"

# CRX3 签名前缀：固定魔数，Chromium 在校验签名时把这 16 字节一起算进去
CRX3_MAGIC = b"CRX3 SignedData\x00"
# 打包进 zip 时跳过的东西（开发/发布用文档不该进安装包）
SKIP_NAMES = {"README.md", "INSTALL.md", ".DS_Store", "Thumbs.db"}
SKIP_DIRS = {"__pycache__", ".git"}


# --------------------------------------------------------------------------- #
# 极简 protobuf 编码（只用到 varint + length-delimited，够表达 CrxFileHeader）
# --------------------------------------------------------------------------- #
def _varint(value: int) -> bytes:
    out = bytearray()
    while True:
        bits = value & 0x7F
        value >>= 7
        if value:
            out.append(bits | 0x80)
        else:
            out.append(bits)
            return bytes(out)


def _field_bytes(field_no: int, payload: bytes) -> bytes:
    """length-delimited 字段：tag + 长度 + 内容"""
    return _varint((field_no << 3) | 2) + _varint(len(payload)) + payload


# --------------------------------------------------------------------------- #
# 密钥与签名
# --------------------------------------------------------------------------- #
def _openssl(*args: str, data: bytes | None = None) -> bytes:
    exe = shutil.which("openssl")
    if not exe:
        sys.exit("找不到 openssl，请先安装（Git for Windows 自带）")
    proc = subprocess.run(
        [exe, *args], input=data, capture_output=True, check=False
    )
    if proc.returncode != 0:
        sys.exit(f"openssl {' '.join(args)} 失败：\n{proc.stderr.decode('utf-8', 'replace')}")
    return proc.stdout


def gen_key(path: Path) -> None:
    if path.exists():
        sys.exit(f"密钥已存在，拒绝覆盖：{path}")
    path.write_bytes(_openssl("genrsa", "2048"))
    print(f"已生成密钥 {path.relative_to(ROOT)}")


def load_key(key_path: Path) -> bytes:
    """取密钥：优先文件，其次环境变量 EXTENSION_KEY_PEM（CI 用）"""
    if key_path.exists():
        return key_path.read_bytes()
    pem = os.environ.get("EXTENSION_KEY_PEM", "").strip()
    if pem:
        # YAML/secret 里换行容易丢，统一按 base64 主体重新折行
        if "-----BEGIN" in pem and "\n" not in pem.strip():
            head, _, rest = pem.partition("-----BEGIN")
            body = re.sub(r"[^A-Za-z0-9+/=]", "", pem)
            raise SystemExit("来自环境变量的 PEM 被压成单行了，请改用文件传入")
        return (pem + "\n").encode()
    sys.exit(
        "没有签名密钥。首次请执行：python tools/build_extension.py --gen-key\n"
        "CI 里请把密钥内容写进仓库 secret EXTENSION_KEY_PEM"
    )


def public_key_der(key_pem: bytes) -> bytes:
    return _openssl("pkey", "-pubout", "-outform", "DER", data=key_pem)


def sign_sha256(key_pem: bytes, data: bytes) -> bytes:
    """RSA PKCS#1 v1.5 + SHA-256，等价于 Chromium 期望的 sha256_with_rsa"""
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        (tmpdir / "key.pem").write_bytes(key_pem)
        (tmpdir / "data.bin").write_bytes(data)
        _openssl(
            "dgst", "-sha256", "-sign", str(tmpdir / "key.pem"),
            "-out", str(tmpdir / "sig.bin"), str(tmpdir / "data.bin"),
        )
        sig = (tmpdir / "sig.bin").read_bytes()
        # 顺手自校验一遍，签名错了在这里就暴露，不用等浏览器报错
        (tmpdir / "pub.der").write_bytes(public_key_der(key_pem))
        ok = subprocess.run(
            [shutil.which("openssl"), "dgst", "-sha256", "-verify",
             str(tmpdir / "pub.der"), "-signature", str(tmpdir / "sig.bin"),
             str(tmpdir / "data.bin")],
            capture_output=True,
        )
        if b"Verified OK" not in ok.stdout:
            sys.exit("签名自校验失败，密钥或数据有问题")
    return sig


def extension_id(pub_der: bytes) -> str:
    """扩展 ID = SHA256(公钥 DER) 前 16 字节，每个十六进制位映射到 a-p"""
    digest = hashlib.sha256(pub_der).hexdigest()[:32]
    return "".join(chr(ord("a") + int(ch, 16)) for ch in digest)


# --------------------------------------------------------------------------- #
# 打包
# --------------------------------------------------------------------------- #
def collect_files() -> list[Path]:
    files = []
    for path in sorted(EXT_DIR.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(EXT_DIR)
        if set(rel.parts) & SKIP_DIRS or rel.name in SKIP_NAMES:
            continue
        files.append(path)
    if not files:
        sys.exit(f"{EXT_DIR} 里没有可打包的文件")
    return files


def build_zip(zip_path: Path) -> bytes:
    """manifest.json 必须在 zip 根目录，商店和 crx 都要求这样"""
    files = collect_files()
    if not any(f.name == "manifest.json" for f in files):
        sys.exit("extension/manifest.json 不存在")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in files:
            rel = path.relative_to(EXT_DIR).as_posix()
            # 固定时间戳，让同样的输入产出同样的 zip，便于比对
            info = zipfile.ZipInfo(rel, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, path.read_bytes())
    return zip_path.read_bytes()


def build_crx(zip_bytes: bytes, key_pem: bytes, crx_path: Path) -> str:
    pub = public_key_der(key_pem)
    ext_id = extension_id(pub)

    # SignedData{crx_id=<前16字节raw>}
    signed_header_data = _field_bytes(1, bytes.fromhex(
        "".join(f"{ord(ch) - ord('a'):x}" for ch in ext_id)
    ))
    # 签名覆盖：魔数 + 小端长度 + signed_header_data + 完整 zip
    signed_payload = (
        CRX3_MAGIC + struct.pack("<I", len(signed_header_data)) + signed_header_data + zip_bytes
    )
    signature = sign_sha256(key_pem, signed_payload)

    proof = _field_bytes(1, pub) + _field_bytes(2, signature)
    header = _field_bytes(2, proof) + _field_bytes(10000, signed_header_data)

    crx_path.write_bytes(
        b"Cr24" + struct.pack("<II", 3, len(header)) + header + zip_bytes
    )
    return ext_id


def build_update_xml(ext_id: str, version: str, crx_url: str) -> str:
    return (
        "<?xml version='1.0' encoding='UTF-8'?>\n"
        "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n"
        f"  <app appid='{ext_id}'>\n"
        f"    <updatecheck codebase='{crx_url}' version='{version}' />\n"
        "  </app>\n"
        "</gupdate>\n"
    )


# --------------------------------------------------------------------------- #
def main() -> None:
    ap = argparse.ArgumentParser(description="打包 Edge/Chrome 扩展")
    ap.add_argument("--key", default=str(DEFAULT_KEY), help="签名密钥路径")
    ap.add_argument("--out", default=str(DIST), help="输出目录")
    ap.add_argument("--gen-key", action="store_true", help="生成签名密钥后退出")
    ap.add_argument(
        "--base-url",
        default=os.environ.get("EXT_CRX_BASE_URL", ""),
        help="crx 的下载地址前缀，update.xml 里的 codebase 用它拼",
    )
    args = ap.parse_args()

    key_path = Path(args.key)
    if args.gen_key:
        gen_key(key_path)
        return

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    manifest = json.loads((EXT_DIR / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    name = "asset-ledger-extension"
    stem = f"{name}-{version}"

    key_pem = load_key(key_path)
    zip_path = out / f"{stem}.zip"
    crx_path = out / f"{stem}.crx"

    zip_bytes = build_zip(zip_path)
    ext_id = build_crx(zip_bytes, key_pem, crx_path)

    base = args.base_url.rstrip("/")
    crx_url = f"{base}/{crx_path.name}" if base else crx_path.name
    xml_path = out / "update.xml"
    xml_path.write_text(build_update_xml(ext_id, version, crx_url), encoding="utf-8")
    (out / "extension-id.txt").write_text(ext_id + "\n", encoding="ascii")

    print(f"扩展名    {manifest['name']}")
    print(f"版本      {version}")
    print(f"扩展 ID   {ext_id}")
    print(f"zip       {zip_path.name}  {len(zip_bytes) / 1024:.1f} KB")
    print(f"crx       {crx_path.name}  {crx_path.stat().st_size / 1024:.1f} KB")
    print(f"update    {xml_path.name}  codebase={crx_url}")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as fh:
            for k, v in {
                "version": version,
                "ext_id": ext_id,
                "crx": crx_path.name,
                "zip": zip_path.name,
            }.items():
                fh.write(f"{k}={v}\n")


if __name__ == "__main__":
    main()
