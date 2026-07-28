"""
photometric_filters.py

TypeScript版の以下4関数をPython(NumPy + OpenCV)に移植:
  - bilateral_filter_full
  - shadow_normalize_full_image
  - suppress_highlights_regional
  - lift_shadows
  - local_contrast_equalize

入出力は元コードに合わせて float32 の 2D 配列 (h, w) を輝度画像として扱う。
0-255 レンジを前提。
"""

from __future__ import annotations

import numpy as np
import cv2


# ---------------------------------------------------------------------------
# 共通ユーティリティ: 積分画像による「境界クリップ済み」ボックス平均
# ---------------------------------------------------------------------------

def _integral_image(gray: np.ndarray) -> np.ndarray:
    """(h+1, w+1) の積分画像を返す。gray は float64 推奨(誤差蓄積対策)。"""
    h, w = gray.shape
    integral = np.zeros((h + 1, w + 1), dtype=np.float64)
    np.cumsum(gray, axis=0, out=integral[1:, 1:])
    np.cumsum(integral[1:, 1:], axis=1, out=integral[1:, 1:])
    return integral


def _box_mean_map(integral: np.ndarray, w: int, h: int, r: int,
                   global_mean: float) -> np.ndarray:
    """
    全画素について、半径 r のボックス平均を「境界でクリップされた実面積」で
    正規化して計算する(元TSの boxMean と同じ挙動)。
    """
    ys, xs = np.meshgrid(np.arange(h), np.arange(w), indexing="ij")
    x1 = np.clip(xs - r, 0, w)
    y1 = np.clip(ys - r, 0, h)
    x2 = np.clip(xs + r + 1, 0, w)
    y2 = np.clip(ys + r + 1, 0, h)

    area = (x2 - x1) * (y2 - y1)
    area_safe = np.where(area > 0, area, 1)

    box_sum = (
        integral[y2, x2] - integral[y1, x2]
        - integral[y2, x1] + integral[y1, x1]
    )
    box_mean = box_sum / area_safe
    box_mean = np.where(area > 0, box_mean, global_mean)
    return box_mean


# ---------------------------------------------------------------------------
# 1. bilateralFilterFull
# ---------------------------------------------------------------------------

def bilateral_filter_radius(sigma_s: float) -> int:
    """bilateral_filter_fullが使うカーネル半径(呼び出し側でクロップ余白を
    決める際にも同じ値を使うための共通関数)。"""
    return min(5, int(np.ceil(sigma_s * 2.5)))


def bilateral_filter_full(
    gray: np.ndarray, sigma_s: float, sigma_r: float, iters: int,
) -> np.ndarray:
    """
    空間カーネル(sigma_s)と輝度差カーネル(sigma_r)による
    バイラテラルフィルタを iters 回反復適用する。

    シフト演算でカーネル窓をベクトル化しているため、
    ピクセル毎の二重ループより大幅に高速。
    """
    h, w = gray.shape
    r = bilateral_filter_radius(sigma_s)
    two_ss2 = 2.0 * sigma_s * sigma_s
    two_sr2 = 2.0 * sigma_r * sigma_r

    # 空間カーネル (kLen x kLen)
    dy, dx = np.meshgrid(np.arange(-r, r + 1), np.arange(-r, r + 1), indexing="ij")
    spatial_k = np.exp(-(dx.astype(np.float64) ** 2 + dy.astype(np.float64) ** 2) / two_ss2)

    # 輝度差カーネル (0..255)
    d = np.arange(256, dtype=np.float64)
    range_k = np.exp(-(d * d) / two_sr2)

    curr = gray.astype(np.float64, copy=True)

    for _ in range(iters):
        # 境界は反射パディングではなく「範囲外は無視」= 元コードの continue と等価にするため
        # パディングして有効/無効マスクで扱う
        padded = np.pad(curr, r, mode="constant", constant_values=np.nan)

        sum_w = np.zeros((h, w), dtype=np.float64)
        sum_wi = np.zeros((h, w), dtype=np.float64)

        for iy in range(2 * r + 1):
            for ix in range(2 * r + 1):
                shifted = padded[iy:iy + h, ix:ix + w]
                valid = ~np.isnan(shifted)

                diff = np.abs(np.where(valid, shifted, 0.0) - curr)
                diff_idx = np.clip(diff.astype(np.int32), 0, 255)

                wt = spatial_k[iy, ix] * range_k[diff_idx]
                wt = np.where(valid, wt, 0.0)

                sum_w += wt
                sum_wi += wt * np.where(valid, shifted, 0.0)

        out = np.where(sum_w > 0, sum_wi / np.where(sum_w > 0, sum_w, 1.0), curr)
        curr = out

    return curr.astype(np.float32)


# ---------------------------------------------------------------------------
# 2. shadowNormalizeFullImage
# ---------------------------------------------------------------------------

def shadow_normalize_full_image(gray: np.ndarray) -> np.ndarray:
    """
    積分画像でボックスブラーして低周波照明を推定し、
    照明ムラを打ち消すように正規化する(影/ハイライトの平準化)。
    """
    h, w = gray.shape
    gray64 = gray.astype(np.float64)
    global_mean = float(gray64.mean())

    integral = _integral_image(gray64)

    # 照明半径: 短辺の 9%(構造エッジより大、照明傾向より小)
    r = max(40, round(min(w, h) * 0.09))
    target = 148.0  # 正規化後の目標輝度

    illum = _box_mean_map(integral, w, h, r, global_mean)

    out = np.where(
        illum < 6,
        gray64,
        np.clip((gray64 / np.where(illum > 0, illum, 1.0)) * target, 0, 255),
    )
    return out.astype(np.float32)


# ---------------------------------------------------------------------------
# 3. suppressHighlightsRegional
# ---------------------------------------------------------------------------

def suppress_highlights_regional(
    gray: np.ndarray,
    sobel_mag: np.ndarray,
    sobel_angle: np.ndarray,
    hl_thresh: float = 215.0,
) -> np.ndarray:
    """
    高輝度領域を検出し、それが「白い物体そのもの」か「照明反射(ハイライト)」かを
    以下のヒューリスティクスで判定し、反射と判定された領域のみ近傍平均へブレンド補正する。

    判定基準:
      (a) 面積が小さすぎる(MIN_AREA未満)クラスタは補正しない
      (b) 勾配分散が低い(平滑) → 反射候補
      (c) 勾配方向がばらけている(方向一貫性が低い)かつ大面積 → 反射候補
      (d) 境界近傍が十分暗い(白い物体なら周囲も明るいはず) → 反射候補側の条件
    """
    h, w = gray.shape
    MIN_AREA = 4
    SURROUND_DARK_GAP = 22.0
    GRAD_VAR_THRESH = 160.0
    GRAD_MAG_SIG = 8.0
    DIR_COHERENCE_THRESH = 0.65

    gray64 = gray.astype(np.float64)
    out = gray64.copy()

    # 1. 高輝度マスク
    hl_mask = (gray64 >= hl_thresh).astype(np.uint8)
    if hl_mask.sum() == 0:
        return out.astype(np.float32)

    # 2. 連結成分ラベリング(BFS相当)
    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(
        hl_mask, connectivity=8
    )

    # 近傍平均(反射補正のブレンド先)用: 少し広めのぼかし
    local_blur = cv2.blur(gray64.astype(np.float32), (9, 9)).astype(np.float64)

    # 境界近傍(白物体 vs 反射の判定)用: リング状の外周を見るため膨張マスクを使う
    dilate_kernel = np.ones((7, 7), np.uint8)

    for label in range(1, num_labels):  # 0 は背景
        area = stats[label, cv2.CC_STAT_AREA]
        if area < MIN_AREA:
            continue

        comp_mask = labels == label

        # 3(a). 勾配分散(平滑ブロブほど分散が低い → 反射候補)
        comp_mag = sobel_mag[comp_mask]
        grad_var = float(comp_mag.var()) if comp_mag.size > 0 else 0.0
        low_grad_var = grad_var < GRAD_VAR_THRESH

        # 3(b). 方向一貫性(有意勾配のみで円形統計量を計算)
        sig_mask = comp_mag >= GRAD_MAG_SIG
        if sig_mask.sum() > 0:
            comp_angle = sobel_angle[comp_mask][sig_mask]
            mean_cos = np.cos(comp_angle).mean()
            mean_sin = np.sin(comp_angle).mean()
            dir_coherence = float(np.hypot(mean_cos, mean_sin))  # 1=一貫, 0=拡散
        else:
            dir_coherence = 1.0  # 有意勾配なし = ほぼ平坦とみなし一貫扱い
        diffuse_direction = dir_coherence < DIR_COHERENCE_THRESH

        # 4. 境界近傍の平均輝度で白い物体か反射かを区別
        dilated = cv2.dilate(comp_mask.astype(np.uint8), dilate_kernel, iterations=1).astype(bool)
        ring_mask = dilated & (~comp_mask)
        if ring_mask.sum() > 0:
            surround_mean = float(gray64[ring_mask].mean())
        else:
            surround_mean = float(gray64[comp_mask].mean())
        comp_mean = float(gray64[comp_mask].mean())
        surrounded_by_dark = (comp_mean - surround_mean) > SURROUND_DARK_GAP

        # 反射候補の総合判定:
        #   平滑(低分散) または (拡散方向 かつ 大面積) であり、
        #   かつ周囲が明確に暗い(=白い物体そのものではない)
        is_large = area >= MIN_AREA * 4
        reflection_candidate = (low_grad_var or (diffuse_direction and is_large)) and surrounded_by_dark

        if not reflection_candidate:
            continue

        # 5. 反射確定領域を近傍平均へブレンド補正
        excess = comp_mean - hl_thresh
        strength = min(0.70, 0.15 + (excess / 40.0) * 0.55)
        strength = max(0.0, strength)

        blended = gray64[comp_mask] * (1 - strength) + local_blur[comp_mask] * strength
        out[comp_mask] = blended

    return np.clip(out, 0, 255).astype(np.float32)


# ---------------------------------------------------------------------------
# 4. liftShadows
# ---------------------------------------------------------------------------

def lift_shadows(gray: np.ndarray, gamma: float = 0.55) -> np.ndarray:
    """
    深い影(輝度が低い領域)をガンマ補正で持ち上げつつ、元値とブレンドする。
    ただし局所平均が十分暗い(均一な黒背景など)場合は変更しない。
    """
    h, w = gray.shape
    SH_THRESH = 55.0  # この輝度以下を「深い影候補」とみなす
    R_SH = 5           # 11x11 近傍

    gray64 = gray.astype(np.float64)
    global_mean = float(gray64.mean())
    integral = _integral_image(gray64)
    local_mean = _box_mean_map(integral, w, h, R_SH, global_mean)

    shadow_mask = gray64 < SH_THRESH
    uniform_dark = local_mean < 32.0
    apply_mask = shadow_mask & (~uniform_dark)

    depth = SH_THRESH - gray64
    strength = np.clip(depth / 45.0, 0.0, 1.0) * 0.55  # 最大 55% 適用

    lifted = np.power(np.clip(gray64, 0, None) / 255.0, gamma) * 255.0

    out = gray64.copy()
    blended = gray64 * (1 - strength) + lifted * strength
    out = np.where(apply_mask, blended, out)

    return out.astype(np.float32)


# ---------------------------------------------------------------------------
# 5. localContrastEqualize
# ---------------------------------------------------------------------------

def local_contrast_equalize(gray: np.ndarray, blend: float = 0.38) -> np.ndarray:
    """
    局所平均・局所標準偏差を積分画像(2パス: 輝度, 輝度^2)で求め、
    局所 Z スコア正規化した結果を元値とブレンドする。
    ほぼ均一な領域(std が極小)は目標平均へ穏やかに引き寄せる。
    """
    h, w = gray.shape
    TARGET_STD = 42.0
    TARGET_MN = 128.0
    R_CE = max(20, round(min(w, h) * 0.05))  # 短辺の 5%

    gray64 = gray.astype(np.float64)
    global_mean = float(gray64.mean())
    global_sq_mean = float((gray64 ** 2).mean())

    integral_1 = _integral_image(gray64)
    integral_2 = _integral_image(gray64 ** 2)

    mean_map = _box_mean_map(integral_1, w, h, R_CE, global_mean)
    sq_mean_map = _box_mean_map(integral_2, w, h, R_CE, global_sq_mean)

    variance = np.clip(sq_mean_map - mean_map ** 2, 0, None)
    std_map = np.sqrt(variance)

    # ほぼ均一領域: 目標平均へ穏やかに引き寄せる
    near_uniform = std_map < 4.0
    uniform_out = gray64 * 0.75 + TARGET_MN * 0.25

    std_safe = np.where(std_map > 0, std_map, 1.0)
    normalized = (gray64 - mean_map) / std_safe * TARGET_STD + TARGET_MN
    blended_out = normalized * blend + gray64 * (1 - blend)

    out = np.where(near_uniform, uniform_out, blended_out)
    return np.clip(out, 0, 255).astype(np.float32)