# -*- coding: utf-8 -*-
"""
io_utils.py
-----------
日本語などの Unicode パスに対応した画像・テキスト I/O ユーティリティ。
cv2.imread / cv2.imwrite は非 ASCII パスで失敗することがあるため、
numpy 経由でバイト列読み書きする方法に統一する。
"""

from __future__ import annotations

import os
import cv2
import numpy as np


def imread_unicode(path: str, flags: int = cv2.IMREAD_COLOR) -> np.ndarray | None:
    """Unicode パスに対応した画像読み込み。失敗時は None を返す。"""
    try:
        buf = np.fromfile(path, dtype=np.uint8)
        img = cv2.imdecode(buf, flags)
        return img
    except Exception:
        return None


def imwrite_unicode(path: str, img: np.ndarray) -> bool:
    """Unicode パスに対応した画像書き込み。成功時は True を返す。"""
    try:
        ext = os.path.splitext(path)[1].lower() or ".png"
        success, buf = cv2.imencode(ext, img)
        if not success:
            return False
        buf.tofile(path)
        return True
    except Exception:
        return False


def write_text_unicode(path: str, content: str, encoding: str = "utf-8") -> bool:
    """Unicode パスに対応したテキスト書き込み。成功時は True を返す。"""
    try:
        with open(path, "w", encoding=encoding) as f:
            f.write(content)
        return True
    except Exception:
        return False


def read_text_unicode(path: str, encoding: str = "utf-8") -> str | None:
    """Unicode パスに対応したテキスト読み込み。失敗時は None を返す。"""
    try:
        with open(path, encoding=encoding) as f:
            return f.read()
    except Exception:
        return None
