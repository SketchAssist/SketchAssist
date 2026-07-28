/**
 * モデルレジストリ
 * 将来 Python サイドカーが使う ONNX モデルの定義。
 * Web モードでは同じ定義を UI 表示用に参照する。
 */

export interface ModelDefinition {
  /** アプリ内の一意識別子 */
  id: string;
  /** 表示名 */
  name: string;
  /** 用途の説明 */
  desc: string;
  /** 想定ファイルサイズ（表示用） */
  sizeLabel: string;
  /** ダウンロード元 URL（将来 HuggingFace Hub 等に差し替え） */
  downloadUrl: string;
  /** SHA-256 チェックサム（将来設定） */
  sha256: string | null;
  /** userData/models/ 以下のファイル名 */
  filename: string;
}

export const MODEL_REGISTRY: ModelDefinition[] = [
  {
    id: "sam2-tiny",
    name: "SAM2 Tiny",
    desc: "輪郭・インスタンス検出",
    sizeLabel: "38 MB",
    downloadUrl: "https://huggingface.co/facebook/sam2-hiera-tiny/resolve/main/sam2_hiera_tiny.pt",
    sha256: null,   // 確定後に設定
    filename: "sam2_hiera_tiny.pt",
  },
  {
    id: "clip-nano",
    name: "CLIP Nano",
    desc: "意味認識・部位ラベリング",
    sizeLabel: "82 MB",
    downloadUrl: "https://huggingface.co/openai/clip-vit-base-patch16/resolve/main/pytorch_model.bin",
    sha256: null,
    filename: "clip_vit_base_patch16.bin",
  },
  {
    id: "potrace",
    name: "Potrace Engine",
    desc: "ベクター変換エンジン",
    sizeLabel: "2 MB",
    // Potrace はビルド済みバイナリを同梱する想定（ダウンロード不要の場合もある）
    downloadUrl: "",
    sha256: null,
    filename: "potrace",
  },
];
